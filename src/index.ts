process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);
setTimeout(() => {}, 100000);

import WebSocket from "ws";
import { Events } from "./Constants";
import { WebSocketShard } from "./WebSocketShard";
import "missing-native-js-functions";
import pako from "pako";
import erlpack from "erlpack";

const server = new WebSocket.Server({
	port: 80,
});

class GatewayError extends Error {
	constructor(public code: number, msg: string) {
		super(msg);
	}
}

const deflator = new pako.Deflate();
const ab = new TextDecoder();

server.on("connection", (socket, request) => {
	try {
		const { url } = request;
		const param = new URLSearchParams(url.split(".").last());

		const version = param.get("v") || "6";
		if (!["6", "7", "8"].includes(version)) throw new GatewayError(4012, "Version not supported");

		const encoding = param.get("encoding") || "json";
		if (!["json", "etf"].includes(encoding)) throw new GatewayError(4002, "Encoding not supported");

		const pack = encoding === "etf" ? erlpack.pack : JSON.stringify;

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

		const compress = param.get("compress") || false;
		if (typeof compress === "string" && !["zlib-stream"].includes(compress))
			throw new GatewayError(4002, "Compression not supported");

		const send = socket.send;
		socket.send = function (data: any) {
			return send.call(this, pack(data));
		};

		socket.send({
			op: 10,
			d: {
				heartbeat_interval: 45000,
			},
		});

		console.log(socket, request);

		socket.on("message", (msg) => {
			msg = unpack(msg);
			console.log(msg);
			// @ts-ignore
			global.test = msg;
		});
	} catch (error) {
		if (error instanceof GatewayError) socket.close(error.code, error.message);
		else {
			socket.close(4000);
			console.error(error);
		}
	}
});

const client = new WebSocketShard({
	id: 0,
	shardCount: 1,
	version: 6,
	token: "",
	intents: 1,
	large_threshold: 50,
});

client.connect();
