// stolen from https://github.com/discordjs/discord.js/blob/master/src/client/websocket/WebSocketShard.js
"use strict";
import WebSocket from "ws";
import { EventEmitter } from "events";
import { Events, OPCodes, ShardEvents, Status, WSEvents } from "./Constants";
import zlib from "zlib-sync";
import erlpack from "erlpack";

const STATUS_KEYS = Object.keys(Status);
const CONNECTION_STATE = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];

const encoding = erlpack ? "etf" : "json";
const pack = erlpack ? erlpack.pack : JSON.stringify;
const ab = new TextDecoder();

function unpack(data: any, type?: string) {
	if (encoding === "json" || type === "json") {
		if (typeof data !== "string") {
			data = ab.decode(data);
		}
		return JSON.parse(data);
	}
	if (!Buffer.isBuffer(data)) data = Buffer.from(new Uint8Array(data));
	return erlpack.unpack(data);
}

export type WebSocketShardOptions = {
	id: number;
	shardCount: number;
	token: string;
	version: number;
	large_threshold: 50;
	intents: number;
};

export interface WebSocketShard {
	on(event: Events, data: any): any;
}

export class WebSocketShard extends EventEmitter {
	public status: Status = Status.IDLE;
	public sequence: number = -1;
	public closeSequence: number = 0;
	public sessionID?: string = null;
	public ping: number = -1;
	public lastPingTimestamp: number = -1;
	public lastHeartbeatAcked: boolean = true;
	public connection?: WebSocket;
	public inflate?: any; // import("zlib-sync").Inflate;
	public helloTimeout?: NodeJS.Timeout;
	public readyTimeout?: NodeJS.Timeout;
	public heartbeatInterval?: NodeJS.Timeout;
	public expectedGuilds?: Set<string>;
	public connectedAt: number = 0;
	public ratelimit: {
		queue: any[];
		total: number;
		remaining: number;
		time: number;
		timer?: NodeJS.Timeout;
	} = {
		queue: [],
		total: 120,
		remaining: 120,
		time: 60e3,
		timer: null,
	};

	constructor(public options: WebSocketShardOptions) {
		super();
	}

	private debug(message: string) {
		// console.debug(message);
	}

	public connect(): Promise<void> {
		const gateway = "wss://gateway.discord.gg/";

		if (this.connection && this.connection.readyState === WebSocket.OPEN && this.status === Status.READY) {
			return Promise.resolve();
		}

		return new Promise((resolve, reject) => {
			const cleanup = () => {
				this.removeListener(ShardEvents.CLOSE, onClose);
				this.removeListener(ShardEvents.READY, onReady);
				this.removeListener(ShardEvents.RESUMED, onResumed);
				this.removeListener(ShardEvents.INVALID_SESSION, onInvalidOrDestroyed);
				this.removeListener(ShardEvents.DESTROYED, onInvalidOrDestroyed);
			};

			const onReady = () => {
				cleanup();
				resolve();
			};

			const onResumed = () => {
				cleanup();
				resolve();
			};

			const onClose = (event: any) => {
				cleanup();
				reject(event);
			};

			const onInvalidOrDestroyed = () => {
				cleanup();
				// eslint-disable-next-line prefer-promise-reject-errors
				reject();
			};

			this.once(ShardEvents.READY, onReady);
			this.once(ShardEvents.RESUMED, onResumed);
			this.once(ShardEvents.CLOSE, onClose);
			this.once(ShardEvents.INVALID_SESSION, onInvalidOrDestroyed);
			this.once(ShardEvents.DESTROYED, onInvalidOrDestroyed);

			if (this.connection && this.connection.readyState === WebSocket.OPEN) {
				this.debug("An open connection was found, attempting an immediate identify.");
				this.identify();
				return;
			}

			if (this.connection) {
				this.debug(`A connection object was found. Cleaning up before continuing.
    State: ${CONNECTION_STATE[this.connection.readyState]}`);
				this.destroy({ emit: false });
			}

			let wsQuery: any = { v: this.options.version };

			if (zlib) {
				this.inflate = new zlib.Inflate({
					chunkSize: 65535,
					flush: zlib.Z_SYNC_FLUSH,
					// @ts-ignore
					to: encoding === "json" ? "string" : "",
				});
				wsQuery.compress = "zlib-stream";
			}

			this.debug(
				`[CONNECT]
    Gateway    : ${gateway}
    Version    : ${this.options.version}
    Encoding   : ${encoding}
    Compression: ${zlib ? "zlib-stream" : "none"}`
			);

			this.status = this.status === Status.DISCONNECTED ? Status.RECONNECTING : Status.CONNECTING;
			this.setHelloTimeout();

			this.connectedAt = Date.now();

			const [g, q] = gateway.split("?");
			wsQuery.encoding = encoding;
			wsQuery = new URLSearchParams(wsQuery);
			if (q) new URLSearchParams(q).forEach((v, k) => wsQuery.set(k, v));

			const ws = (this.connection = new WebSocket(`${g}?${wsQuery}`));
			ws.onopen = this.onOpen.bind(this);
			ws.onmessage = this.onMessage.bind(this);
			ws.onerror = this.onError.bind(this);
			ws.onclose = this.onClose.bind(this);
		});
	}

	/**
	 * Called whenever a connection is opened to the gateway.
	 * @private
	 */
	onOpen() {
		this.debug(`[CONNECTED] ${this.connection.url} in ${Date.now() - this.connectedAt}ms`);
		this.status = Status.NEARLY;
	}

	/**
	 * Called whenever a message is received.
	 * @param {MessageEvent} event Event received
	 * @private
	 */
	onMessage({ data }: any) {
		let raw;
		if (data instanceof ArrayBuffer) data = new Uint8Array(data);
		if (zlib) {
			const l = data.length;
			const flush =
				l >= 4 && data[l - 4] === 0x00 && data[l - 3] === 0x00 && data[l - 2] === 0xff && data[l - 1] === 0xff;

			this.inflate.push(data, flush && zlib.Z_SYNC_FLUSH);
			if (!flush) return;
			raw = this.inflate.result;
		} else {
			raw = data;
		}
		let packet;
		try {
			packet = unpack(raw);
			this.emit(Events.RAW, packet);
			if (packet.op === OPCodes.DISPATCH) this.emit(packet.t, packet.d);
		} catch (err) {
			this.emit(Events.SHARD_ERROR, err);
			return;
		}
		this.onPacket(packet);
	}

	/**
	 * Called whenever an error occurs with the WebSocket.
	 * @param {ErrorEvent} event The error that occurred
	 * @private
	 */
	onError(event: any) {
		const error = event && event.error ? event.error : event;
		if (!error) return;

		/**
		 * Emitted whenever a shard's WebSocket encounters a connection error.
		 * @event Client#shardError
		 * @param {Error} error The encountered error
		 * @param {number} shardID The shard that encountered this error
		 */
		this.emit(Events.SHARD_ERROR, error);
	}

	/**
	 * @external CloseEvent
	 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent}
	 */

	/**
	 * @external ErrorEvent
	 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/ErrorEvent}
	 */

	/**
	 * @external MessageEvent
	 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/MessageEvent}
	 */

	/**
	 * Called whenever a connection to the gateway is closed.
	 * @param {CloseEvent} event Close event that was received
	 * @private
	 */
	onClose(event: CloseEvent) {
		if (this.sequence !== -1) this.closeSequence = this.sequence;
		this.sequence = -1;

		this.debug(`[CLOSE]
    Event Code: ${event.code}
    Clean     : ${event.wasClean}
    Reason    : ${event.reason || "No reason received"}`);

		this.setHeartbeatTimer(-1);
		this.setHelloTimeout(-1);
		// If we still have a connection object, clean up its listeners
		if (this.connection) this._cleanupConnection();

		this.status = Status.DISCONNECTED;

		/**
		 * Emitted when a shard's WebSocket closes.
		 * @private
		 * @event WebSocketShard#close
		 * @param {CloseEvent} event The received event
		 */
		this.emit(ShardEvents.CLOSE, event);
	}

	/**
	 * Called whenever a packet is received.
	 * @param {Object} packet The received packet
	 * @private
	 */
	onPacket(packet: any) {
		if (!packet) {
			this.debug(`Received broken packet: '${packet}'.`);
			return;
		}

		switch (packet.t) {
			case WSEvents.READY:
				/**
				 * Emitted when the shard receives the READY payload and is now waiting for guilds
				 * @event WebSocketShard#ready
				 */
				this.emit(ShardEvents.READY);

				this.sessionID = packet.d.session_id;
				this.expectedGuilds = new Set(packet.d.guilds.map((d: any) => d.id));
				this.status = Status.WAITING_FOR_GUILDS;
				this.debug(`[READY] Session ${this.sessionID}.`);
				this.lastHeartbeatAcked = true;
				this.sendHeartbeat("ReadyHeartbeat");
				break;
			case WSEvents.RESUMED: {
				/**
				 * Emitted when the shard resumes successfully
				 * @event WebSocketShard#resumed
				 */
				this.emit(ShardEvents.RESUMED);

				this.status = Status.READY;
				const replayed = packet.s - this.closeSequence;
				this.debug(`[RESUMED] Session ${this.sessionID} | Replayed ${replayed} events.`);
				this.lastHeartbeatAcked = true;
				this.sendHeartbeat("ResumeHeartbeat");
				break;
			}
		}

		if (packet.s > this.sequence) this.sequence = packet.s;

		switch (packet.op) {
			case OPCodes.HELLO:
				this.setHelloTimeout(-1);
				this.setHeartbeatTimer(packet.d.heartbeat_interval);
				this.identify();
				break;
			case OPCodes.RECONNECT:
				this.debug("[RECONNECT] Discord asked us to reconnect");
				this.destroy({ closeCode: 4000 });
				break;
			case OPCodes.INVALID_SESSION:
				this.debug(`[INVALID SESSION] Resumable: ${packet.d}.`);
				// If we can resume the session, do so immediately
				if (packet.d) {
					this.identifyResume();
					return;
				}
				// Reset the sequence
				this.sequence = -1;
				// Reset the session ID as it's invalid
				this.sessionID = null;
				// Set the status to reconnecting
				this.status = Status.RECONNECTING;
				// Finally, emit the INVALID_SESSION event
				this.emit(ShardEvents.INVALID_SESSION);
				break;
			case OPCodes.HEARTBEAT_ACK:
				this.ackHeartbeat();
				break;
			case OPCodes.HEARTBEAT:
				this.sendHeartbeat("HeartbeatRequest", true);
				break;
			default:
				this.emit(packet.t, packet.d);
				if (this.status === Status.WAITING_FOR_GUILDS && packet.t === WSEvents.GUILD_CREATE) {
					this.expectedGuilds.delete(packet.d.id);
					this.checkReady();
				}
		}
	}

	/**
	 * Checks if the shard can be marked as ready
	 * @private
	 */
	checkReady() {
		// Step 0. Clear the ready timeout, if it exists
		if (this.readyTimeout) {
			clearTimeout(this.readyTimeout);
			this.readyTimeout = null;
		}
		// Step 1. If we don't have any other guilds pending, we are ready
		if (!this.expectedGuilds.size) {
			this.debug("Shard received all its guilds. Marking as fully ready.");
			this.status = Status.READY;

			/**
			 * Emitted when the shard is fully ready.
			 * This event is emitted if:
			 * * all guilds were received by this shard
			 * * the ready timeout expired, and some guilds are unavailable
			 * @event WebSocketShard#allReady
			 * @param {?Set<string>} unavailableGuilds Set of unavailable guilds, if any
			 */
			this.emit(ShardEvents.ALL_READY);
			return;
		}
		// Step 2. Create a 15s timeout that will mark the shard as ready if there are still unavailable guilds
		this.readyTimeout = setTimeout(() => {
			this.debug(`Shard did not receive any more guild packets in 15 seconds.
  Unavailable guild count: ${this.expectedGuilds.size}`);

			this.readyTimeout = null;

			this.status = Status.READY;

			this.emit(ShardEvents.ALL_READY, this.expectedGuilds);
		}, 15000);
	}

	private setHelloTimeout(time?: number) {
		if (time === -1) {
			if (this.helloTimeout) {
				this.debug("Clearing the HELLO timeout.");
				clearTimeout(this.helloTimeout);
				this.helloTimeout = null;
			}
			return;
		}
		this.debug("Setting a HELLO timeout for 20s.");
		this.helloTimeout = setTimeout(() => {
			this.debug("Did not receive HELLO in time. Destroying and connecting again.");
			this.destroy({ reset: true, closeCode: 4009 });
		}, 20000);
	}

	private setHeartbeatTimer(time: number) {
		if (time === -1) {
			if (this.heartbeatInterval) {
				this.debug("Clearing the heartbeat interval.");
				clearInterval(this.heartbeatInterval);
				this.heartbeatInterval = null;
			}
			return;
		}
		this.debug(`Setting a heartbeat interval for ${time}ms.`);
		// Sanity checks
		if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
		this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), time);
	}

	/**
	 * Sends a heartbeat to the WebSocket.
	 * If this shard didn't receive a heartbeat last time, it will destroy it and reconnect
	 * @param {string} [tag='HeartbeatTimer'] What caused this heartbeat to be sent
	 * @param {boolean} [ignoreHeartbeatAck] If we should send the heartbeat forcefully.
	 * @private
	 */
	sendHeartbeat(
		tag = "HeartbeatTimer",
		ignoreHeartbeatAck = [Status.WAITING_FOR_GUILDS, Status.IDENTIFYING, Status.RESUMING].includes(this.status)
	) {
		if (ignoreHeartbeatAck && !this.lastHeartbeatAcked) {
			this.debug(`[${tag}] Didn't process heartbeat ack yet but we are still connected. Sending one now.`);
		} else if (!this.lastHeartbeatAcked) {
			this.debug(
				`[${tag}] Didn't receive a heartbeat ack last time, assuming zombie connection. Destroying and reconnecting.
    Status          : ${STATUS_KEYS[this.status]}
    Sequence        : ${this.sequence}
    Connection State: ${this.connection ? CONNECTION_STATE[this.connection.readyState] : "No Connection??"}`
			);

			this.destroy({ closeCode: 4009, reset: true });
			return;
		}

		this.debug(`[${tag}] Sending a heartbeat.`);
		this.lastHeartbeatAcked = false;
		this.lastPingTimestamp = Date.now();
		this.send({ op: OPCodes.HEARTBEAT, d: this.sequence }, true);
	}

	/**
	 * Acknowledges a heartbeat.
	 * @private
	 */
	ackHeartbeat() {
		this.lastHeartbeatAcked = true;
		const latency = Date.now() - this.lastPingTimestamp;
		this.debug(`Heartbeat acknowledged, latency of ${latency}ms.`);
		this.ping = latency;
	}

	/**
	 * Identifies the client on the connection.
	 * @private
	 * @returns {void}
	 */
	identify() {
		return this.sessionID ? this.identifyResume() : this.identifyNew();
	}

	/**
	 * Identifies as a new connection on the gateway.
	 * @private
	 */
	identifyNew() {
		if (!this.options.token) {
			this.debug("[IDENTIFY] No token available to identify a new session.");
			return;
		}

		this.status = Status.IDENTIFYING;

		// Clone the identify payload and assign the token and shard info
		const d = {
			version: this.options.version,
			token: this.options.token,
			shard: [this.options.id, Number(this.options.shardCount)],
			intents: this.options.intents,
			compress: true,
			large_threshold: this.options.large_threshold,
			properties: {
				$browser: "lambert-gateway",
				$device: "lambert-gateway",
				$os: process.platform,
			},
		};

		this.debug(`[IDENTIFY] Shard ${this.options.id}/${this.options.shardCount}`);
		this.send({ op: OPCodes.IDENTIFY, d }, true);
	}

	private identifyResume() {
		if (!this.sessionID) {
			this.debug("[RESUME] No session ID was present; identifying as a new session.");
			this.identifyNew();
			return;
		}

		this.status = Status.RESUMING;

		this.debug(`[RESUME] Session ${this.sessionID}, sequence ${this.closeSequence}`);

		const d = {
			version: this.options.version,
			token: this.options.token,
			session_id: this.sessionID,
			seq: this.closeSequence,
		};

		this.send({ op: OPCodes.RESUME, d }, true);
	}

	public send(data: any, important = false) {
		this.ratelimit.queue[important ? "unshift" : "push"](data);
		this.processQueue();
	}

	private _send(data: any) {
		if (!this.connection || this.connection.readyState !== WebSocket.OPEN) {
			this.debug(`Tried to send packet '${JSON.stringify(data)}' but no WebSocket is available!`);
			this.destroy({ closeCode: 4000 });
			return;
		}

		this.connection.send(pack(data), (err) => {
			if (err) this.emit(Events.SHARD_ERROR, err);
		});
	}

	private processQueue() {
		if (this.ratelimit.remaining === 0) return;
		if (this.ratelimit.queue.length === 0) return;
		if (this.ratelimit.remaining === this.ratelimit.total) {
			this.ratelimit.timer = setTimeout(() => {
				this.ratelimit.remaining = this.ratelimit.total;
				this.processQueue();
			}, this.ratelimit.time);
		}
		while (this.ratelimit.remaining > 0) {
			const item = this.ratelimit.queue.shift();
			if (!item) return;
			this._send(item);
			this.ratelimit.remaining--;
		}
	}

	private destroy({ closeCode = 1000, reset = false, emit = true, log = true } = {}) {
		if (log) {
			this.debug(`[DESTROY]
    Close Code    : ${closeCode}
    Reset         : ${reset}
    Emit DESTROYED: ${emit}`);
		}

		// Step 0: Remove all timers
		this.setHeartbeatTimer(-1);
		this.setHelloTimeout(-1);

		// Step 1: Close the WebSocket connection, if any, otherwise, emit DESTROYED
		if (this.connection) {
			// If the connection is currently opened, we will (hopefully) receive close
			if (this.connection.readyState === WebSocket.OPEN) {
				this.connection.close(closeCode);
			} else {
				// Connection is not OPEN
				this.debug(`WS State: ${CONNECTION_STATE[this.connection.readyState]}`);
				// Remove listeners from the connection
				this._cleanupConnection();
				// Attempt to close the connection just in case
				try {
					this.connection.close(closeCode);
				} catch {
					// No-op
				}
				// Emit the destroyed event if needed
				if (emit) this._emitDestroyed();
			}
		} else if (emit) {
			// We requested a destroy, but we had no connection. Emit destroyed
			this._emitDestroyed();
		}

		// Step 2: Null the connection object
		this.connection = null;

		// Step 3: Set the shard status to DISCONNECTED
		this.status = Status.DISCONNECTED;

		// Step 4: Cache the old sequence (use to attempt a resume)
		if (this.sequence !== -1) this.closeSequence = this.sequence;

		// Step 5: Reset the sequence and session ID if requested
		if (reset) {
			this.sequence = -1;
			this.sessionID = null;
		}

		// Step 6: reset the ratelimit data
		this.ratelimit.remaining = this.ratelimit.total;
		this.ratelimit.queue.length = 0;
		if (this.ratelimit.timer) {
			clearTimeout(this.ratelimit.timer);
			this.ratelimit.timer = null;
		}
	}

	private _cleanupConnection() {
		this.connection.onopen = this.connection.onclose = this.connection.onerror = this.connection.onmessage = null;
	}

	private _emitDestroyed() {
		/**
		 * Emitted when a shard is destroyed, but no WebSocket connection was present.
		 * @private
		 * @event WebSocketShard#destroyed
		 */
		this.emit(ShardEvents.DESTROYED);
	}
}
