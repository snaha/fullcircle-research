// POT JS pot-node.js
//
// This file is required by node.js-based scripts to make use of POT JS.
//
// -----------------------------------------------------------------------------

// Go wasm_exec.js
//
// This is the generic JS WASM initializer provided by the Go compiler.
//
// Copyright 2018 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license:
//
// Copyright 2009 The Go Authors.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//    * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//    * Neither the name of Google LLC nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

"use strict";

(() => {
	const enosys = () => {
		const err = new Error("not implemented");
		err.code = "ENOSYS";
		return err;
	};

	if (!globalThis.fs) {
		let outputBuf = "";
		globalThis.fs = {
			constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1, O_DIRECTORY: -1 }, // unused
			writeSync(fd, buf) {
				outputBuf += decoder.decode(buf);
				const nl = outputBuf.lastIndexOf("\n");
				if (nl != -1) {
					console.log(outputBuf.substring(0, nl));
					outputBuf = outputBuf.substring(nl + 1);
				}
				return buf.length;
			},
			write(fd, buf, offset, length, position, callback) {
				if (offset !== 0 || length !== buf.length || position !== null) {
					callback(enosys());
					return;
				}
				const n = this.writeSync(fd, buf);
				callback(null, n);
			},
			chmod(path, mode, callback) { callback(enosys()); },
			chown(path, uid, gid, callback) { callback(enosys()); },
			close(fd, callback) { callback(enosys()); },
			fchmod(fd, mode, callback) { callback(enosys()); },
			fchown(fd, uid, gid, callback) { callback(enosys()); },
			fstat(fd, callback) { callback(enosys()); },
			fsync(fd, callback) { callback(null); },
			ftruncate(fd, length, callback) { callback(enosys()); },
			lchown(path, uid, gid, callback) { callback(enosys()); },
			link(path, link, callback) { callback(enosys()); },
			lstat(path, callback) { callback(enosys()); },
			mkdir(path, perm, callback) { callback(enosys()); },
			open(path, flags, mode, callback) { callback(enosys()); },
			read(fd, buffer, offset, length, position, callback) { callback(enosys()); },
			readdir(path, callback) { callback(enosys()); },
			readlink(path, callback) { callback(enosys()); },
			rename(from, to, callback) { callback(enosys()); },
			rmdir(path, callback) { callback(enosys()); },
			stat(path, callback) { callback(enosys()); },
			symlink(path, link, callback) { callback(enosys()); },
			truncate(path, length, callback) { callback(enosys()); },
			unlink(path, callback) { callback(enosys()); },
			utimes(path, atime, mtime, callback) { callback(enosys()); },
		};
	}

	if (!globalThis.process) {
		globalThis.process = {
			getuid() { return -1; },
			getgid() { return -1; },
			geteuid() { return -1; },
			getegid() { return -1; },
			getgroups() { throw enosys(); },
			pid: -1,
			ppid: -1,
			umask() { throw enosys(); },
			cwd() { throw enosys(); },
			chdir() { throw enosys(); },
		}
	}

	if (!globalThis.path) {
		globalThis.path = {
			resolve(...pathSegments) {
				return pathSegments.join("/");
			}
		}
	}

	if (!globalThis.crypto) {
		throw new Error("globalThis.crypto is not available, polyfill required (crypto.getRandomValues only)");
	}

	if (!globalThis.performance) {
		throw new Error("globalThis.performance is not available, polyfill required (performance.now only)");
	}

	if (!globalThis.TextEncoder) {
		throw new Error("globalThis.TextEncoder is not available, polyfill required");
	}

	if (!globalThis.TextDecoder) {
		throw new Error("globalThis.TextDecoder is not available, polyfill required");
	}

	const encoder = new TextEncoder("utf-8");
	const decoder = new TextDecoder("utf-8");

	globalThis.Go = class {
		constructor() {
			this.argv = ["js"];
			this.env = {};
			this.exit = (code) => {
				if (code !== 0) {
					console.warn("exit code:", code);
				}
			};
			this._exitPromise = new Promise((resolve) => {
				this._resolveExitPromise = resolve;
			});
			this._pendingEvent = null;
			this._scheduledTimeouts = new Map();
			this._nextCallbackTimeoutID = 1;

			const setInt64 = (addr, v) => {
				this.mem.setUint32(addr + 0, v, true);
				this.mem.setUint32(addr + 4, Math.floor(v / 4294967296), true);
			}

			const setInt32 = (addr, v) => {
				this.mem.setUint32(addr + 0, v, true);
			}

			const getInt64 = (addr) => {
				const low = this.mem.getUint32(addr + 0, true);
				const high = this.mem.getInt32(addr + 4, true);
				return low + high * 4294967296;
			}

			const loadValue = (addr) => {
				const f = this.mem.getFloat64(addr, true);
				if (f === 0) {
					return undefined;
				}
				if (!isNaN(f)) {
					return f;
				}

				const id = this.mem.getUint32(addr, true);
				return this._values[id];
			}

			const storeValue = (addr, v) => {
				const nanHead = 0x7FF80000;

				if (typeof v === "number" && v !== 0) {
					if (isNaN(v)) {
						this.mem.setUint32(addr + 4, nanHead, true);
						this.mem.setUint32(addr, 0, true);
						return;
					}
					this.mem.setFloat64(addr, v, true);
					return;
				}

				if (v === undefined) {
					this.mem.setFloat64(addr, 0, true);
					return;
				}

				let id = this._ids.get(v);
				if (id === undefined) {
					id = this._idPool.pop();
					if (id === undefined) {
						id = this._values.length;
					}
					this._values[id] = v;
					this._goRefCounts[id] = 0;
					this._ids.set(v, id);
				}
				this._goRefCounts[id]++;
				let typeFlag = 0;
				switch (typeof v) {
					case "object":
						if (v !== null) {
							typeFlag = 1;
						}
						break;
					case "string":
						typeFlag = 2;
						break;
					case "symbol":
						typeFlag = 3;
						break;
					case "function":
						typeFlag = 4;
						break;
				}
				this.mem.setUint32(addr + 4, nanHead | typeFlag, true);
				this.mem.setUint32(addr, id, true);
			}

			const loadSlice = (addr) => {
				const array = getInt64(addr + 0);
				const len = getInt64(addr + 8);
				return new Uint8Array(this._inst.exports.mem.buffer, array, len);
			}

			const loadSliceOfValues = (addr) => {
				const array = getInt64(addr + 0);
				const len = getInt64(addr + 8);
				const a = new Array(len);
				for (let i = 0; i < len; i++) {
					a[i] = loadValue(array + i * 8);
				}
				return a;
			}

			const loadString = (addr) => {
				const saddr = getInt64(addr + 0);
				const len = getInt64(addr + 8);
				return decoder.decode(new DataView(this._inst.exports.mem.buffer, saddr, len));
			}

			const testCallExport = (a, b) => {
				this._inst.exports.testExport0();
				return this._inst.exports.testExport(a, b);
			}

			const timeOrigin = Date.now() - performance.now();
			this.importObject = {
				_gotest: {
					add: (a, b) => a + b,
					callExport: testCallExport,
				},
				gojs: {
					// Go's SP does not change as long as no Go code is running. Some operations (e.g. calls, getters and setters)
					// may synchronously trigger a Go event handler. This makes Go code get executed in the middle of the imported
					// function. A goroutine can switch to a new stack if the current stack is too small (see morestack function).
					// This changes the SP, thus we have to update the SP used by the imported function.

					// func wasmExit(code int32)
					"runtime.wasmExit": (sp) => {
						sp >>>= 0;
						const code = this.mem.getInt32(sp + 8, true);
						this.exited = true;
						delete this._inst;
						delete this._values;
						delete this._goRefCounts;
						delete this._ids;
						delete this._idPool;
						this.exit(code);
					},

					// func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)
					"runtime.wasmWrite": (sp) => {
						sp >>>= 0;
						const fd = getInt64(sp + 8);
						const p = getInt64(sp + 16);
						const n = this.mem.getInt32(sp + 24, true);
						fs.writeSync(fd, new Uint8Array(this._inst.exports.mem.buffer, p, n));
					},

					// func resetMemoryDataView()
					"runtime.resetMemoryDataView": (sp) => {
						sp >>>= 0;
						this.mem = new DataView(this._inst.exports.mem.buffer);
					},

					// func nanotime1() int64
					"runtime.nanotime1": (sp) => {
						sp >>>= 0;
						setInt64(sp + 8, (timeOrigin + performance.now()) * 1000000);
					},

					// func walltime() (sec int64, nsec int32)
					"runtime.walltime": (sp) => {
						sp >>>= 0;
						const msec = (new Date).getTime();
						setInt64(sp + 8, msec / 1000);
						this.mem.setInt32(sp + 16, (msec % 1000) * 1000000, true);
					},

					// func scheduleTimeoutEvent(delay int64) int32
					"runtime.scheduleTimeoutEvent": (sp) => {
						sp >>>= 0;
						const id = this._nextCallbackTimeoutID;
						this._nextCallbackTimeoutID++;
						this._scheduledTimeouts.set(id, setTimeout(
							() => {
								this._resume();
								while (this._scheduledTimeouts.has(id)) {
									// for some reason Go failed to register the timeout event, log and try again
									// (temporary workaround for https://github.com/golang/go/issues/28975)
									console.warn("scheduleTimeoutEvent: missed timeout event");
									this._resume();
								}
							},
							getInt64(sp + 8),
						));
						this.mem.setInt32(sp + 16, id, true);
					},

					// func clearTimeoutEvent(id int32)
					"runtime.clearTimeoutEvent": (sp) => {
						sp >>>= 0;
						const id = this.mem.getInt32(sp + 8, true);
						clearTimeout(this._scheduledTimeouts.get(id));
						this._scheduledTimeouts.delete(id);
					},

					// func getRandomData(r []byte)
					"runtime.getRandomData": (sp) => {
						sp >>>= 0;
						crypto.getRandomValues(loadSlice(sp + 8));
					},

					// func finalizeRef(v ref)
					"syscall/js.finalizeRef": (sp) => {
						sp >>>= 0;
						const id = this.mem.getUint32(sp + 8, true);
						this._goRefCounts[id]--;
						if (this._goRefCounts[id] === 0) {
							const v = this._values[id];
							this._values[id] = null;
							this._ids.delete(v);
							this._idPool.push(id);
						}
					},

					// func stringVal(value string) ref
					"syscall/js.stringVal": (sp) => {
						sp >>>= 0;
						storeValue(sp + 24, loadString(sp + 8));
					},

					// func valueGet(v ref, p string) ref
					"syscall/js.valueGet": (sp) => {
						sp >>>= 0;
						const result = Reflect.get(loadValue(sp + 8), loadString(sp + 16));
						sp = this._inst.exports.getsp() >>> 0; // see comment above
						storeValue(sp + 32, result);
					},

					// func valueSet(v ref, p string, x ref)
					"syscall/js.valueSet": (sp) => {
						sp >>>= 0;
						Reflect.set(loadValue(sp + 8), loadString(sp + 16), loadValue(sp + 32));
					},

					// func valueDelete(v ref, p string)
					"syscall/js.valueDelete": (sp) => {
						sp >>>= 0;
						Reflect.deleteProperty(loadValue(sp + 8), loadString(sp + 16));
					},

					// func valueIndex(v ref, i int) ref
					"syscall/js.valueIndex": (sp) => {
						sp >>>= 0;
						storeValue(sp + 24, Reflect.get(loadValue(sp + 8), getInt64(sp + 16)));
					},

					// valueSetIndex(v ref, i int, x ref)
					"syscall/js.valueSetIndex": (sp) => {
						sp >>>= 0;
						Reflect.set(loadValue(sp + 8), getInt64(sp + 16), loadValue(sp + 24));
					},

					// func valueCall(v ref, m string, args []ref) (ref, bool)
					"syscall/js.valueCall": (sp) => {
						sp >>>= 0;
						try {
							const v = loadValue(sp + 8);
							const m = Reflect.get(v, loadString(sp + 16));
							const args = loadSliceOfValues(sp + 32);
							const result = Reflect.apply(m, v, args);
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 56, result);
							this.mem.setUint8(sp + 64, 1);
						} catch (err) {
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 56, err);
							this.mem.setUint8(sp + 64, 0);
						}
					},

					// func valueInvoke(v ref, args []ref) (ref, bool)
					"syscall/js.valueInvoke": (sp) => {
						sp >>>= 0;
						try {
							const v = loadValue(sp + 8);
							const args = loadSliceOfValues(sp + 16);
							const result = Reflect.apply(v, undefined, args);
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, result);
							this.mem.setUint8(sp + 48, 1);
						} catch (err) {
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, err);
							this.mem.setUint8(sp + 48, 0);
						}
					},

					// func valueNew(v ref, args []ref) (ref, bool)
					"syscall/js.valueNew": (sp) => {
						sp >>>= 0;
						try {
							const v = loadValue(sp + 8);
							const args = loadSliceOfValues(sp + 16);
							const result = Reflect.construct(v, args);
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, result);
							this.mem.setUint8(sp + 48, 1);
						} catch (err) {
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, err);
							this.mem.setUint8(sp + 48, 0);
						}
					},

					// func valueLength(v ref) int
					"syscall/js.valueLength": (sp) => {
						sp >>>= 0;
						setInt64(sp + 16, parseInt(loadValue(sp + 8).length));
					},

					// valuePrepareString(v ref) (ref, int)
					"syscall/js.valuePrepareString": (sp) => {
						sp >>>= 0;
						const str = encoder.encode(String(loadValue(sp + 8)));
						storeValue(sp + 16, str);
						setInt64(sp + 24, str.length);
					},

					// valueLoadString(v ref, b []byte)
					"syscall/js.valueLoadString": (sp) => {
						sp >>>= 0;
						const str = loadValue(sp + 8);
						loadSlice(sp + 16).set(str);
					},

					// func valueInstanceOf(v ref, t ref) bool
					"syscall/js.valueInstanceOf": (sp) => {
						sp >>>= 0;
						this.mem.setUint8(sp + 24, (loadValue(sp + 8) instanceof loadValue(sp + 16)) ? 1 : 0);
					},

					// func copyBytesToGo(dst []byte, src ref) (int, bool)
					"syscall/js.copyBytesToGo": (sp) => {
						sp >>>= 0;
						const dst = loadSlice(sp + 8);
						const src = loadValue(sp + 32);
						if (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) {
							this.mem.setUint8(sp + 48, 0);
							return;
						}
						const toCopy = src.subarray(0, dst.length);
						dst.set(toCopy);
						setInt64(sp + 40, toCopy.length);
						this.mem.setUint8(sp + 48, 1);
					},

					// func copyBytesToJS(dst ref, src []byte) (int, bool)
					"syscall/js.copyBytesToJS": (sp) => {
						sp >>>= 0;
						const dst = loadValue(sp + 8);
						const src = loadSlice(sp + 16);
						if (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)) {
							this.mem.setUint8(sp + 48, 0);
							return;
						}
						const toCopy = src.subarray(0, dst.length);
						dst.set(toCopy);
						setInt64(sp + 40, toCopy.length);
						this.mem.setUint8(sp + 48, 1);
					},

					"debug": (value) => {
						console.log(value);
					},
				}
			};
		}

		async run(instance) {
			if (!(instance instanceof WebAssembly.Instance)) {
				throw new Error("Go.run: WebAssembly.Instance expected");
			}
			this._inst = instance;
			this.mem = new DataView(this._inst.exports.mem.buffer);
			this._values = [ // JS values that Go currently has references to, indexed by reference id
				NaN,
				0,
				null,
				true,
				false,
				globalThis,
				this,
			];
			this._goRefCounts = new Array(this._values.length).fill(Infinity); // number of references that Go has to a JS value, indexed by reference id
			this._ids = new Map([ // mapping from JS values to reference ids
				[0, 1],
				[null, 2],
				[true, 3],
				[false, 4],
				[globalThis, 5],
				[this, 6],
			]);
			this._idPool = [];   // unused ids that have been garbage collected
			this.exited = false; // whether the Go program has exited

			// Pass command line arguments and environment variables to WebAssembly by writing them to the linear memory.
			let offset = 4096;

			const strPtr = (str) => {
				const ptr = offset;
				const bytes = encoder.encode(str + "\0");
				new Uint8Array(this.mem.buffer, offset, bytes.length).set(bytes);
				offset += bytes.length;
				if (offset % 8 !== 0) {
					offset += 8 - (offset % 8);
				}
				return ptr;
			};

			const argc = this.argv.length;

			const argvPtrs = [];
			this.argv.forEach((arg) => {
				argvPtrs.push(strPtr(arg));
			});
			argvPtrs.push(0);

			const keys = Object.keys(this.env).sort();
			keys.forEach((key) => {
				argvPtrs.push(strPtr(`${key}=${this.env[key]}`));
			});
			argvPtrs.push(0);

			const argv = offset;
			argvPtrs.forEach((ptr) => {
				this.mem.setUint32(offset, ptr, true);
				this.mem.setUint32(offset + 4, 0, true);
				offset += 8;
			});

			// The linker guarantees global data starts from at least wasmMinDataAddr.
			// Keep in sync with cmd/link/internal/ld/data.go:wasmMinDataAddr.
			const wasmMinDataAddr = 4096 + 8192;
			if (offset >= wasmMinDataAddr) {
				throw new Error("total length of command line and environment variables exceeds limit");
			}

			this._inst.exports.run(argc, argv);
			if (this.exited) {
				this._resolveExitPromise();
			}
			await this._exitPromise;
		}

		_resume() {
			if (this.exited) {
				throw new Error("Go program has already exited");
			}
			this._inst.exports.resume();
			if (this.exited) {
				this._resolveExitPromise();
			}
		}

		_makeFuncWrapper(id) {
			const go = this;
			return function () {
				const event = { id: id, this: this, args: arguments };
				go._pendingEvent = event;
				go._resume();
				return event.result;
			};
		}
	}
})();

// end of Go wasm_exec.js

// Heavily pruned XMLHttpRequest-ssl. Added binary POST, suppressed shortening,
// deleted async send, listeners, header and method checks. Removed agent mode.
//
// This class implements a blocking fetch as required by the Go POT persister.
//
// It does so by spawning a worker thread to receive async responses while the
// main thread waits in a dead loop until a signal for completion comes in form
// of a deleted file.
//
// This is from the original head of XMLHttpRequest-ssl:

/**
** Wrapper for built-in http.js to emulate the browser XMLHttpRequest object.
**
** @author Dan DeFelippi <dan@driverdan.com>
** @contributor David Ellis <d.f.ellis@ieee.org>
** @license MIT
**
** Fixed binary post data, mod of npm-published mjwwit fork:
** npm https://www.npmjs.com/package/xmlhttprequest-ssl/v/1.6.3
** https://github.com/mjwwit/node-XMLHttpRequest/blob/master/lib/XMLHttpRequest.js
**/

/**
** Constants
**/

var stateConstants = {
	UNSENT: 0,
	OPENED: 1,
	HEADERS_RECEIVED: 2,
	LOADING: 3,
	DONE: 4
};

var assignStateConstants = function (object) {
	for (let stateKey in stateConstants) Object.defineProperty(object, stateKey, {
		enumerable: true,
		writable: false,
		configurable: false,
		value: stateConstants[stateKey]
	});
}

assignStateConstants(XMLHttpRequest);

/**
** Module exports.
**/

/**
** `XMLHttpRequest` constructor.
**
** @param {Object} opts optional "options" object
**/

function XMLHttpRequest(opts) {
	"use strict";

	if (!new.target) {
		throw new TypeError("Failed to construct 'XMLHttpRequest': Please use the 'new' operator, this object constructor cannot be called as a function.");
	}

	var dataMap = Object.create(null);

	/**
	** Safely assign any key with value to an object, preventing prototype pollution
	** @param {any} obj Object to assign
	** @param {any} key key name
	** @param {any} value value to assign
	** @param {boolean} assignable whether user can change this value (this defaults to `true` when value is a function)
	**/
	var assignProp = function (obj, key, value, assignable) {
		if ("function" === typeof value) Object.defineProperty(obj, key, {
			value: value,
			writable: true,
			enumerable: true,
			configurable: true
		});
		else if (assignable) Object.defineProperty(obj, key, {
			get: function () { return dataMap[key]; },
			set: function (value) { dataMap[key] = value; },
			enumerable: true,
			configurable: true
		});
		else Object.defineProperty(obj, key, {
			get: function () { return dataMap[key]; },
			set: undefined,
			enumerable: true,
			configurable: true
		});
	}

	// defines a list of default options to prevent parameters pollution
	var default_options = {
		pfx: undefined,
		key: undefined,
		passphrase: undefined,
		cert: undefined,
		ca: undefined,
		ciphers: undefined,
		rejectUnauthorized: true,
		autoUnref: false,
		allowFileSystemResources: true,
		maxRedirects: 20, // Chrome standard
		xmlParser: function (text) {
			return null;
		},
		textDecoder: function (buf, enc) {
			if ("function" === typeof TextDecoder) try {
				return new TextDecoder(enc).decode(buf);
			}
			catch (e) {}
			return buf.toString(enc);
		},
		origin: undefined
	};

	opts = Object.assign(Object.create(null), default_options, opts);

	for (var i of ["xmlParser", "textDecoder"]) {
		if (typeof opts[i] !== "function") {
			opts[i] = default_options[i];
		}
	}

	var sslOptions = {
		pfx: opts.pfx,
		key: opts.key,
		passphrase: opts.passphrase,
		cert: opts.cert,
		ca: opts.ca,
		ciphers: opts.ciphers,
		rejectUnauthorized: opts.rejectUnauthorized !== false
	};

	/**
	** Private variables
	**/
	var self = this;
	var http = require('http');
	var https = require('https');

	var maxRedirects = opts.maxRedirects;
	if (typeof maxRedirects !== 'number' || Number.isNaN(maxRedirects)) maxRedirects = 20;
	else maxRedirects = Math.max(maxRedirects, 0);

	var redirectCount = 0;

	// Holds http.js objects
	var request;
	var response;

	// Request settings
	var settings = Object.create(null);

	assignStateConstants(this);

	// Set some default headers
	var defaultHeaders = {
		"User-Agent": "node-XMLHttpRequest",
		"Accept": "*/*"
	};

	var headers = Object.assign(Object.create(null), defaultHeaders);

	// Send flag
	var sendFlag = false;
	// Error flag, used when errors occur or abort is called
	var errorFlag = false;
	var abortedFlag = false;

	// Custom encoding (if user called via xhr.overrideMimeType)
	var customEncoding = "";

	// private ready state (not exposed so user cannot modify)
	var readyState = this.UNSENT;

	// default ready state change handler in case one is not set or is set late
	assignProp(this, 'onreadystatechange', null, true);

	// Result & response
	assignProp(this, 'responseText', "");
	assignProp(this, "responseXML", "");
	assignProp(this, "responseURL", "");
	assignProp(this, "response", Buffer.alloc(0));
	assignProp(this, "status", null);
	assignProp(this, "statusText", null);

	// xhr.responseType is supported:
	//   When responseType is 'text' or '', self.responseText will be utf8 decoded text.
	//   When responseType is 'json', self.responseText initially will be utf8 decoded text,
	//   which is then JSON parsed into self.response.
	//   When responseType is 'arraybuffer', self.response is an ArrayBuffer.
	//   When responseType is 'blob', self.response is a Blob.
	// cf. section 3.6, subsections 8,9,10,11 of https://xhr.spec.whatwg.org/#the-response-attribute
	assignProp(this, "responseType", "", true); /* 'arraybuffer' or 'text' or '' or 'json' or 'blob' */

	/**
	** Private methods
	**/


	/**
	** Given the user-input (or Content-Type header value) of MIME type,
	** Parse given string to retrieve mimeType and its encoding (defaults to utf8 if not exists)
	** @param {string} contentType
	**/
	var parseContentType = function (contentType) {
		const regex = /([a-zA-Z0-9!#$%&'*+.^_`|~-]+\/[a-zA-Z0-9!#$%&'*+.^_`|~-]+)(?:; charset=([a-zA-Z0-9-]+))?/;

		const matches = contentType.toLowerCase().match(regex);

		if (matches) {
			const mimeType = matches[1];
			const charset = matches[2] || 'utf-8';

			return { mimeType, charset };
		} else {
			return { mimeType: "", charset: "utf-8" }
		}
	}

	/**
	** Called when an error is encountered to deal with it.
	** @param  status  {number}    HTTP status code to use rather than the default (0) for XHR errors.
	**/
	var handleError = function(error, status) {
		dataMap.status = status || 0;
		dataMap.statusText = error.message || "";
		dataMap.responseText = "";
		dataMap.responseXML = "";
		dataMap.responseURL = "";
		dataMap.response = Buffer.alloc(0);
		errorFlag = true;
		setState(self.DONE);
		throw error;
	};

	/**
	** Construct the correct form of response, given default content type
	**
	** The input is the response parameter which is a Buffer.
	** When self.responseType is "", "text",
	**   the input is further refined to be: new TextDecoder(encoding).decode(response),
	**   encoding is defined either by `Content-Type` header or set through `xhr.overrideMimetype()`.
	** When self.responseType is "json",
	**   the input is further refined to be: JSON.parse(response.toString('utf8')).
	** A special case is when self.responseType is "document",
	**   the decoded text will be passed to a parser function to create a DOM, or returns `null`
	**
	** @param {Buffer} response
	**/
	var createResponse = function(response, customContentType) {
		dataMap.responseText = null;
		dataMap.responseXML = null;
		switch (self.responseType) {
			case 'json':
				dataMap.response = JSON.parse(response.toString('utf8'));
				break;
			case 'blob':
			case 'arraybuffer':
				// When self.responseType === 'arraybuffer', self.response is an ArrayBuffer.
				// Get the correct sized ArrayBuffer.
				dataMap.response = response; //// added
				if (dataMap.responseType === 'blob' && typeof Blob === 'function') {
					// Construct the Blob object that contains response.
					dataMap.response = new Blob([self.response]);
				}
				break;
			default:
				try {
					dataMap.responseText = opts.textDecoder.call(opts, response, customEncoding || parseContentType(String(customContentType)).charset);
				}
				catch (e) {
					// fall back to utf8 ONLY if custom encoding is present
					if (customEncoding) dataMap.responseText = response.toString('utf8');
					else dataMap.responseText = "";
				}
				dataMap.response = self.responseText;
				try { dataMap.responseXML = opts.xmlParser.call(opts, self.responseText); }
				catch (e) { dataMap.responseXML = null; }
		}

		// Special handling of self.responseType === 'document'
		if (dataMap.responseType === 'document') {
			dataMap.response = self.responseXML;
			dataMap.responseText = null;
		}
	}

	/**
	** Public methods
	**/

	/**
	** Open the connection. Currently supports local server requests.
	**
	** @param string method Connection method (eg GET, POST)
	** @param string url URL for the connection.
	**/
	assignProp(this, 'open', function(method, url) {
		abort();
		errorFlag = false;
		abortedFlag = false;

		settings = {
			"method": method.toUpperCase(),
			"url": url,
		};

		// parse origin
		try {
			settings.origin = new URL(opts.origin);
		}
		catch (e) {
			settings.origin = null;
		}

		setState(this.OPENED);
	});

	/**
	** Sets a header for the request.
	**
	** @param string header Header name
	** @param string value Header value
	** @return boolean Header added
	**/
	assignProp(this, 'setRequestHeader', function(header, value) {
		if (readyState != this.OPENED) {
			throw new Error("INVALID_STATE_ERR: setRequestHeader can only be called when state is OPEN");
		}
		if (sendFlag) {
			throw new Error("INVALID_STATE_ERR: send flag is true");
		}
		headers[header] = value;
		return true;
	});


	/**
	** Sends the request to the server.
	**
	** @param string data Optional data to send as request body.
	**/
	assignProp(this, 'send', function(data) {
		if (readyState != this.OPENED) {
			throw new Error("INVALID_STATE_ERR: connection must be opened before send() is called");
		}

		if (sendFlag) {
			throw new Error("INVALID_STATE_ERR: send has already been called");
		}

		var isSsl = false, isLocal = false, isDataUri = false;
		var url;
		try {
			if (settings.origin) {
				url = new URL(settings.url, settings.origin);
			}
			else {
				url = new URL(settings.url);
			}
			settings.url = url.href;
		}
		catch (e) {
			// URL parsing throws TypeError, here we only want to take its message
			handleError(new Error(e.message));
			return;
		}
		var host;
		// Determine the server
		switch (url.protocol) {
			case 'https:':
				isSsl = true;
				// SSL & non-SSL both need host, no break here.
			case 'http:':
				host = url.hostname;
				break;

			case 'data:':
				isDataUri = true;

			case 'file:':
				isLocal = true;
				break;

			case undefined:
			case '':
				host = "localhost";
				break;

			default:
				throw new Error("Protocol not supported.");
		}

		// Default to port 80. If accessing localhost on another port be sure
		// to use http://localhost:port/path
		var port = url.port || (isSsl ? 443 : 80);
		// Add query string if one is used
		var uri = url.pathname + (url.search || '');

		// Set the Host header or the server may reject the request
		headers["Host"] = host;
		if (!((isSsl && port === 443) || port === 80)) {
			headers["Host"] += ':' + url.port;
		}

		// Set content length header
		if (settings.method === "GET" || settings.method === "HEAD") {
			data = null;
		} else if (data) {
			headers["Content-Length"] = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);

			var headersKeys = Object.keys(headers);
			if (!headersKeys.some(function (h) { return h.toLowerCase() === 'content-type' })) {
				headers["Content-Type"] = "text/plain;charset=UTF-8";
			}
		} else if (settings.method === "POST") {
			// For a post with no data set Content-Length: 0.
			// This is required by buggy servers that don't meet the specs.
			headers["Content-Length"] = 0;
		}

		var options = {
			host: host,
			port: port,
			path: uri,
			method: settings.method,
			headers: headers,
		};

		// Reset error flag
		errorFlag = false;
		try {
			// Create a temporary file for communication with the other Node process
			var tmpDir = os.tmpdir();
			var syncResponse;
			var contentFile = path.join(tmpDir, ".node-xmlhttprequest-content-" + process.pid);
			if(opts.verbosity % 1024 > 4) console.log("jsx:  ∙ content file: " + contentFile)
			var syncFile = path.join(tmpDir, ".node-xmlhttprequest-sync-" + process.pid);
			fs.writeFileSync(syncFile, "", "utf8");
			// The async request the other Node process executes
			var execString = "'use strict';"
				+ "var http = require('http'), https = require('https'), fs = require('fs');"
				+ "function concat(bufferArray) {"
				+ "  let length = 0, offset = 0;"
				+ "  for (let k = 0; k < bufferArray.length; k++)"
				+ "    length += bufferArray[k].length;"
				+ "  const result = Buffer.alloc(length);"
				+ "  for (let k = 0; k < bufferArray.length; k++) {"
				+ "    for (let i = 0; i < bufferArray[k].length; i++) {"
				+ "      result[offset+i] = bufferArray[k][i]"
				+ "    }"
				+ "    offset += bufferArray[k].length;"
				+ "  }"
				+ "  return result;"
				+ "};"
				+ "var doRequest = http" + (isSsl ? "s" : "") + ".request;"
				+ "var isSsl = " + !!isSsl + ";"
				+ "var options = " + JSON.stringify(options) + ";"
				+ "var sslOptions = " + JSON.stringify(sslOptions) + ";"
				+ "var responseData = Buffer.alloc(0);"
				+ "var buffers = [];"
				+ "var url = new URL(" + JSON.stringify(settings.url) + ");"
				+ "var maxRedirects = " + maxRedirects + ", redirects_count = 0;"
				+ "var makeRequest = function () {"
				+ "  var opt = Object.assign(Object.create(null), options);"
				+ "  if (isSsl) Object.assign(opt, sslOptions);"
				+ "  var req = doRequest(opt, function(response) {"
				+ "    if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303 || response.statusCode === 307 || response.statusCode === 308) {"
				+ "      response.destroy();"
				+ "      ++redirects_count;"
				+ "      if (redirects_count > maxRedirects) {"
				+ "        fs.writeFileSync('" + contentFile + "', 'NODE-XMLHTTPREQUEST-ERROR-REDIRECT: Too many redirects', 'utf8');"
				+ "        fs.unlinkSync('" + syncFile + "');"
				+ "        return;"
				+ "      }"
				+ "      try {"
				+ "        url = new URL(response.headers.location, url);"
				+ "        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw 'bad protocol';"
				+ "      }"
				+ "      catch (e) {"
				+ "        fs.writeFileSync('" + contentFile + "', 'NODE-XMLHTTPREQUEST-ERROR-REDIRECT: Unsafe redirect', 'utf8');"
				+ "        fs.unlinkSync('" + syncFile + "');"
				+ "        return;"
				+ "      };"
				+ "      isSsl = url.protocol === 'https:';"
				+ "      doRequest = isSsl ? https.request : http.request;"
				+ "      var port = url.port;"
				+ "      options = {"
				+ "        hostname: url.hostname,"
				+ "        port: port,"
				+ "        path: url.pathname + (url.search || ''),"
				+ "        method: response.statusCode === 303 ? 'GET' : options.method,"
				+ "        headers: options.headers"
				+ "      };"
				+ "      options.headers['Host'] = url.host;"
				+ "      if (!((isSsl && port === 443) || port === 80)) options.headers['Host'] += ':' + port;"
				+ "      makeRequest();"
				+ "      return;"
				+ "    }"
				+ "    response.on('data', function(chunk) {"
				+ "      buffers.push(chunk);"
				+ "    });"
				+ "    response.on('end', function() {"
				+ "      responseData = concat(buffers);"
				+ "      fs.writeFileSync('" + contentFile + "', JSON.stringify({err: null, data: { url: url.href, statusCode: response.statusCode, statusText: response.statusMessage, headers: response.headers }}), 'utf8');"
				+ "      fs.writeFileSync('" + contentFile + ".bin', responseData);"
				+ "      fs.unlinkSync('" + syncFile + "');"
				+ "    });"
				+ "    response.on('error', function(error) {"
				+ "      fs.writeFileSync('" + contentFile + "', 'NODE-XMLHTTPREQUEST-ERROR:' + JSON.stringify(error), 'utf8');"
				+ "      fs.unlinkSync('" + syncFile + "');"
				+ "    });"
				+ "  }).on('error', function(error) {"
				+ "    fs.writeFileSync('" + contentFile + "', 'NODE-XMLHTTPREQUEST-ERROR:' + JSON.stringify(error), 'utf8');"
				+ "    fs.unlinkSync('" + syncFile + "');"
				+ "  });"
				+ "  " + (data && !(data instanceof Uint8Array) ? "req.write('" + JSON.stringify(data).slice(1,-1).replace(/'/g, "\\'") + "');":"")
				+ "  " + (data && (data instanceof Uint8Array) ? "req.write(new Uint8Array(" + JSON.stringify(Array.from(data)) + "));":"")
				+ "  req.end();"
				+ "};"
				+ "makeRequest();"
			// Start the other Node Process, executing this string
			var syncProc = spawn(process.argv[0], ["-e", execString]);
			while(fs.existsSync(syncFile)) {
				// Wait while the sync file is empty
			}
			syncResponse = fs.readFileSync(contentFile, 'utf8');
			// Kill the child process once the file has data
			syncProc.stdin.end();
			// Remove the temporary file
			fs.unlinkSync(contentFile);
		}
		catch (e) {
			handleError(new Error("Synchronous operation aborted: Unable to access the OS temporary directory for read/write operations."));
		}
		if (syncResponse.match(/^NODE-XMLHTTPREQUEST-ERROR(-REDIRECT){0,1}:/)) {
			// If the file returned an error, handle it
			if (syncResponse.startsWith('NODE-XMLHTTPREQUEST-ERROR-REDIRECT')) {
				handleError(new Error(syncResponse.replace(/^NODE-XMLHTTPREQUEST-ERROR-REDIRECT: /, "")));
			}
			else {
				var errorObj = JSON.parse(syncResponse.replace(/^NODE-XMLHTTPREQUEST-ERROR:/, ""));
				handleError(errorObj, 503);
			}
		} else try {
			// If the file returned okay, parse its data and move to the DONE state
			const resp = JSON.parse(syncResponse);
			dataMap.status = resp.data.statusCode;
			dataMap.statusText = resp.data.statusText;
			dataMap.responseURL = resp.data.url;
			dataMap.response = fs.readFileSync(contentFile + ".bin");
			fs.unlinkSync(contentFile + ".bin");
			// Use self.responseType to create the correct self.responseType, self.response, self.responseXML.
			createResponse(self.response, resp.data.headers["content-type"] || "");
			// Set up response correctly.
			response = {
				statusCode: self.status,
				headers: resp.data.headers
			};
			setState(self.DONE);
		}
		catch (e) {
			handleError(new Error("Synchronous operation aborted: Unable to access the OS temporary directory for read/write operations."));
		}
	});

	/**
	** Aborts a request.
	**/
	var abort = function() {
		if (request) {
			request.abort();
			request = null;
		}

		headers = Object.assign(Object.create(null), defaultHeaders);
		dataMap.responseText = "";
		dataMap.responseXML = "";
		dataMap.response = Buffer.alloc(0);

		errorFlag = abortedFlag = true
		if (readyState !== self.UNSENT
				&& (readyState !== self.OPENED || sendFlag)
				&& readyState !== self.DONE) {
			sendFlag = false;
			setState(self.DONE);
		}
		readyState = self.UNSENT;
	};

	/**
	** Aborts a request.
	**/
	assignProp(this, 'abort', abort);

	/**
	** Changes readyState and calls onreadystatechange.
	**
	** @param int state New state
	**/
	var setState = function(state) {
		if ((readyState === state) || (readyState === self.UNSENT && abortedFlag))
			return

		readyState = state;
	};
};

// end of modified XMLHttpRequest-ssl.

// POT JS pot-node-init.js

var fs = require('fs');
var os = require('os');
var path = require('path');
var spawn = require('child_process').spawn;

// create the pot object, which at this point is empty apart from the Kvs
// constructor. Note pot.newSync() does not at this point exist.
if(typeof global.pot == 'undefined')
	global.pot = {
		Kvs: function(bee, batch, timeout, raw) {
			return global.pot.newSync(bee, batch, timeout, raw) 
		}
	}

// create the weak-referenced garbage collection ping to Go.
global.pot.registry = new FinalizationRegistry((slotRef) => { global.pot.release(slotRref) })

// 1st attempt at init, trying default pot.wasm location, i.e, ./ of this file.
// the two attempts allow for require with or without parameter. The challenge
// is that the 1st time arround it is unknown whether the 2nd will happen.
// This is why an error message is cast into the wait-promise pot.ready().
// In case an app calls it before it was replaced by the real initialization-
// wait promise ([*]), this means that the 2nd run did not happen although
// the first run did not succeed locating pot.wasm.
var wasmPath = path.resolve(__dirname, "pot.wasm")
if(fs.existsSync(wasmPath)) {
	init(wasmPath)
} else {
	// temporary replacement of pot.ready in case pot.wasm is never found
        global.pot.ready = () => { new Promise(() => {
		console.log("fatal: can't locate pot.wasm in " + __dirname)
		process.exit(2)
        })}
}

// 2nd attempt at init, with explicit path parameter appended to require
// e.g., require("lib/pot-node.js")("../someplace/pot.wasm", verbosity)
module.exports = (first, second) => {

	let wasmPath = first
	let verbosity = second

	// unpack parameters
	if(typeof first == 'number') {
		wasmPath = undefined
		verbosity = first
	}

	// if init ran already (pot.started is set), a new path comes too late.
	if(wasmPath && global.pot && global.pot.started) {
		console.error("fatal: can't use specified path when pot.wasm is present in " + __dirname)
		process.exit(3)
	}

	// call init only if it hasn't run before (did not SET pot.ready).
	if(!global.pot || !global.pot.started) {
		init(wasmPath, verbosity)
	// else set only verbosity. Note works because of the JS single-thread.
	} else {
		global.potVerbosity = verbosity
	}

	return global.pot
}

// load and start the wasm executable, which will keep running to receive calls.
function init(wasmPath, verbosity) {

	// stop the delayed error message from 1st attempt to initialize
	if(global.pot && global.pot.trap) clearTimeout(global.pot.trap)

	// If pot.ready is set, init must have run before; prevents involuntary.
	if(global.pot && global.pot.started) {
		console.error("fatal: double initialization. Set pot.started null first.")
		process.exit(4)
	}

	// potVerbosity will be picked up by the wasm's main.
	if(verbosity)
		global.potVerbosity = verbosity

	// amend the wasm search path with the root of the caller module's.
	// if wasmPath was undefined, it defaults to pot.wasm, then gets the path.
	if(verbosity % 1024 >= 5) console.log("jsi:  ∙ path argument : ", wasmPath ? wasmPath : "-")
	if(!wasmPath) wasmPath = "pot.wasm"
	wasmPath = path.resolve(__dirname, wasmPath)
	if(verbosity % 1024 >= 5) console.log("jsi:  ∙ resulting path: ", wasmPath)

	if(!fs.existsSync(wasmPath)) {
		console.error("fatal: missing wasm file " + wasmPath)
		process.exit(5)
	}

	// a function of Go's initialization procedure for wasm executables.
	var go = new Go()

	// the cross-closure tangle to trigger pot.ready's resolution from
	// the _onPotInitialized() function that is in turn triggered by the wasm.
	var potResolve

	if(verbosity % 1024 >= 5) console.log("jsi:  ∙ pot wasm initialization")

	global.pot.start = new Promise((resolve, reject) => {
		potResolve = resolve
		WebAssembly.instantiate(fs.readFileSync(wasmPath), go.importObject)
			.then((r) => { go.run(r.instance) })
			.catch((e) => { reject(e) })
	})
	global.pot.started = true

	global._onPotInitialized = () => potResolve(global.pot)

	global.pot.ready = () => { return global.pot.start }

	if(verbosity % 1024 >= 5) console.log("jsi:  ∙ pot.ready initialized")

	return global.pot
}

// jsFetchSync is called from the Go POT WASM Swarm Node.js LoadSaver to make
// a blocking fetch. It uses the modified XMLHttpRequest-ssl above.
global.jsFetchSync = function(method, url, data, headers, verbosity) {

	const log = msg => { if(verbosity % 1024 >= 5) console.log(msg) }

	log("jsf:  ∙ fetch sync url     : " + url)
	log("jsf:  ∙ fetch sync headers : " + (headers ? Object.keys(headers).map(k => k + ":" + headers[k]).join() : ""))
	log("jsf:  ∙ fetch sync data    : " + data)

	var xhr = new XMLHttpRequest({verbosity: verbosity});
	if(method=='GET') xhr.responseType = 'arraybuffer'
	try {
		xhr.open(method, url, false) // false = sync

		for (const hi in headers)
			xhr.setRequestHeader(hi, headers[hi])

		const bytes = data ? Uint8Array.from(data.match(/.{2}/g).map((byte) => parseInt(byte, 16))) : null
		if(bytes) log("jsf:  ∙ fetch sync byte len: " + bytes.length)

		xhr.send(bytes)

		if(typeof xhr.response == 'string')
			log("jsf:  ∙ fetch sync response: " + xhr.response.replaceAll("\n", "\\n"))
		if(xhr.response instanceof Uint8Array)
			log("jsf:  ∙ fetch sync response: " + Array.from(xhr.response).map(b=>(b<=15?"0":"")+b.toString(16)).join(''))

		return xhr.response
	}
	catch (error) {
		console.error(error.message);
	}
}

// end of POT JS pot-node-init.js


// end of POT JS pot-node.js
