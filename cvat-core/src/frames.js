/*
* Copyright (C) 2019 Intel Corporation
* SPDX-License-Identifier: MIT
*/

/* global
    require:false
    global:false
*/

(() => {
    const cvatData = require('../../cvat-data');
    const PluginRegistry = require('./plugins');
    const serverProxy = require('./server-proxy');
    const { isBrowser, isNode } = require('browser-or-node');
    const { Exception, ArgumentError } = require('./exceptions');

    // This is the frames storage
    const frameDataCache = {};

    /**
        * Class provides meta information about specific frame and frame itself
        * @memberof module:API.cvat.classes
        * @hideconstructor
    */
    class FrameData {
        constructor(width, height, tid, number, startFrame, stopFrame) {
            Object.defineProperties(this, Object.freeze({
                /**
                    * @name width
                    * @type {integer}
                    * @memberof module:API.cvat.classes.FrameData
                    * @readonly
                    * @instance
                */
                width: {
                    value: width,
                    writable: false,
                },
                /**
                    * @name height
                    * @type {integer}
                    * @memberof module:API.cvat.classes.FrameData
                    * @readonly
                    * @instance
                */
                height: {
                    value: height,
                    writable: false,
                },
                tid: {
                    value: tid,
                    writable: false,
                },
                number: {
                    value: number,
                    writable: false,
                },
                startFrame: {
                    value: startFrame,
                    writable: false,
                },
                stopFrame: {
                    value: stopFrame,
                    writable: false,
                },
            }));
        }

        /**
            * Method returns URL encoded image which can be placed in the img tag
            * @method data
            * @returns {string}
            * @memberof module:API.cvat.classes.FrameData
            * @instance
            * @async
            * @param {function} [onServerRequest = () => {}]
            * callback which will be called if data absences local
            * @throws {module:API.cvat.exception.ServerError}
            * @throws {module:API.cvat.exception.PluginError}
        */
        async data(onServerRequest = () => {}) {
            const result = await PluginRegistry
                .apiWrapper.call(this, FrameData.prototype.data, onServerRequest);
            return result;
        }
    }

    FrameData.prototype.data.implementation = async function (onServerRequest) {
        return new Promise((resolve, reject) => {
            const resolveWrapper = (data) => {
                this._data = data;
                return resolve(this._data);
            };

            if (this._data) {
                resolve(this._data);
                return;
            }

            const { provider } = frameDataCache[this.tid];
            const { chunkSize } = frameDataCache[this.tid];
            const start = Math.max(
                this.startFrame,
                parseInt(this.number / chunkSize, 10) * chunkSize,
            );
            const stop = Math.min(
                this.stopFrame,
                (parseInt(this.number / chunkSize, 10) + 1) * chunkSize - 1,
            );
            const chunkNumber = Math.floor(this.number / chunkSize);

            const onDecodeAll = async (frameNumber) => {
                if (frameDataCache[this.tid].activeChunkRequest
                    && chunkNumber === frameDataCache[this.tid].activeChunkRequest.chunkNumber) {
                    const callbackArray = frameDataCache[this.tid].activeChunkRequest.callbacks;
                    for (let i = callbackArray.length - 1; i >= 0; --i) {
                        if (callbackArray[i].frameNumber === frameNumber) {
                            const callback = callbackArray[i];
                            callbackArray.splice(i, 1);
                            callback.resolve(await provider.frame(callback.frameNumber));
                        }
                    }
                    if (callbackArray.length === 0) {
                        frameDataCache[this.tid].activeChunkRequest = undefined;
                    }
                }
            };

            const rejectRequestAll = () => {
                if (frameDataCache[this.tid].activeChunkRequest
                    && chunkNumber === frameDataCache[this.tid].activeChunkRequest.chunkNumber) {
                    for (const r of frameDataCache[this.tid].activeChunkRequest.callbacks) {
                        r.reject(r.frameNumber);
                    }
                    frameDataCache[this.tid].activeChunkRequest = undefined;
                }
            };

            const makeActiveRequest = () => {
                const taskDataCache = frameDataCache[this.tid];
                const activeChunk = taskDataCache.activeChunkRequest;
                activeChunk.request = serverProxy.frames.getData(this.tid,
                    activeChunk.chunkNumber).then((chunk) => {
                    frameDataCache[this.tid].activeChunkRequest.completed = true;
                    if (!taskDataCache.nextChunkRequest) {
                        provider.requestDecodeBlock(chunk,
                            taskDataCache.activeChunkRequest.start,
                            taskDataCache.activeChunkRequest.stop,
                            taskDataCache.activeChunkRequest.onDecodeAll,
                            taskDataCache.activeChunkRequest.rejectRequestAll);
                    }
                }).catch((exception) => {
                    if (exception instanceof Exception) {
                        reject(exception);
                    } else {
                        reject(new Exception(exception.message));
                    }
                }).finally(() => {
                    if (taskDataCache.nextChunkRequest) {
                        if (taskDataCache.activeChunkRequest) {
                            for (const r of taskDataCache.activeChunkRequest.callbacks) {
                                r.reject(r.frameNumber);
                            }
                        }
                        taskDataCache.activeChunkRequest = taskDataCache.nextChunkRequest;
                        taskDataCache.nextChunkRequest = undefined;
                        makeActiveRequest();
                    }
                });
            };

            if (isNode) {
                resolve('Dummy data');
            } else if (isBrowser) {
                provider.frame(this.number).then((frame) => {
                    if (frame === null) {
                        onServerRequest();
                        if (!provider.isChunkCached(start, stop)) {
                            if (!frameDataCache[this.tid].activeChunkRequest
                                || (frameDataCache[this.tid].activeChunkRequest
                                && frameDataCache[this.tid].activeChunkRequest.completed
                                && frameDataCache[this.tid].activeChunkRequest.chunkNumber
                                    !== chunkNumber)) {
                                if (frameDataCache[this.tid].activeChunkRequest) {
                                    frameDataCache[this.tid].activeChunkRequest.rejectRequestAll();
                                }
                                frameDataCache[this.tid].activeChunkRequest = {
                                    request: undefined,
                                    chunkNumber,
                                    start,
                                    stop,
                                    onDecodeAll,
                                    rejectRequestAll,
                                    completed: false,
                                    callbacks: [{
                                        resolve: resolveWrapper,
                                        reject,
                                        frameNumber: this.number,
                                    }],
                                };
                                makeActiveRequest();
                            } else if (frameDataCache[this.tid].activeChunkRequest.chunkNumber
                                        === chunkNumber) {
                                frameDataCache[this.tid].activeChunkRequest.callbacks.push({
                                    resolve: resolveWrapper,
                                    reject,
                                    frameNumber: this.number,
                                });
                            } else {
                                if (frameDataCache[this.tid].nextChunkRequest) {
                                    const { callbacks } = frameDataCache[this.tid].nextChunkRequest;
                                    for (const r of callbacks) {
                                        r.reject(r.frameNumber);
                                    }
                                }
                                frameDataCache[this.tid].nextChunkRequest = {
                                    request: undefined,
                                    chunkNumber,
                                    start,
                                    stop,
                                    onDecodeAll,
                                    rejectRequestAll,
                                    completed: false,
                                    callbacks: [{
                                        resolve: resolveWrapper,
                                        reject,
                                        frameNumber: this.number,
                                    }],
                                };
                            }
                        } else {
                            frameDataCache[this.tid].activeChunkRequest.callbacks.push({
                                resolve: resolveWrapper,
                                reject,
                                frameNumber: this.number,
                            });
                            provider.requestDecodeBlock(null, start, stop,
                                onDecodeAll, rejectRequestAll);
                        }
                    } else {
                        resolveWrapper(frame);
                    }
                }).catch((exception) => {
                    if (exception instanceof Exception) {
                        reject(exception);
                    } else {
                        reject(new Exception(exception.message));
                    }
                });
            }
        });
    };

    const getFrameSize = (taskID, frame) => {
        const { meta, mode } = frameDataCache[taskID];
        let size = null;
        if (mode === 'interpolation') {
            [size] = meta.frames;
        } else if (mode === 'annotation') {
            if (frame >= meta.size) {
                throw new ArgumentError(
                    `Meta information about frame ${frame} can't be received from the server`,
                );
            } else {
                size = meta.frames[frame];
            }
        } else {
            throw new ArgumentError(
                `Invalid mode is specified ${mode}`,
            );
        }
        return size;
    };

    class FrameBuffer {
        constructor(size, chunkSize, stopFrame, taskID) {
            this._size = size;
            this._buffer = {};
            this._requestedChunks = {};
            this._chunkSize = chunkSize;
            this._stopFrame = stopFrame;
            this._activeFillBufferRequest = false;
            this._taskID = taskID;
        }

        getFreeBufferSize() {
            let requestedFrameCount = 0;
            for (const chunkIdx in this._requestedChunks) {
                if (Object.prototype.hasOwnProperty.call(this._requestedChunks, chunkIdx)) {
                    requestedFrameCount += this._requestedChunks[chunkIdx].requestedFrames.size;
                }
            }
            return this._size - Object.keys(this._buffer).length - requestedFrameCount;
        }

        requestOneChunkFrames(chunkIdx) {
            return new Promise((resolve, reject) => {
                this._requestedChunks[chunkIdx] = {
                    ...this._requestedChunks[chunkIdx],
                    resolve,
                    reject,
                };
                for (const frame of this._requestedChunks[chunkIdx].requestedFrames.entries()) {
                    const requestedFrame = frame[1];
                    const size = getFrameSize(this._taskID, requestedFrame);
                    const frameData = new FrameData(
                        size.width,
                        size.height,
                        this._taskID,
                        requestedFrame,
                        frameDataCache[this._taskID].startFrame,
                        frameDataCache[this._taskID].stopFrame,
                    );

                    frameData.data().then(() => {
                        if (!(chunkIdx in this._requestedChunks)
                          || !this._requestedChunks[chunkIdx].requestedFrames.has(requestedFrame)) {
                            reject(chunkIdx);
                        } else {
                            this._requestedChunks[chunkIdx].requestedFrames.delete(requestedFrame);
                            this._requestedChunks[chunkIdx].buffer[requestedFrame] = frameData;
                            if (this._requestedChunks[chunkIdx].requestedFrames.size === 0) {
                                const bufferedframes = Object.keys(
                                    this._requestedChunks[chunkIdx].buffer,
                                ).map((f) => +f);
                                this._requestedChunks[chunkIdx].resolve(new Set(bufferedframes));
                            }
                        }
                    }).catch(() => {
                        reject(chunkIdx);
                    });
                }
            });
        }

        fillBuffer(startFrame, frameStep = 1, count = null) {
            const freeSize = this.getFreeBufferSize();
            const requestedFrameCount = count ? count * frameStep : freeSize * frameStep;
            const stopFrame = Math.min(startFrame + requestedFrameCount, this._stopFrame + 1);

            for (let i = startFrame; i < stopFrame; i += frameStep) {
                const chunkIdx = Math.floor(i / this._chunkSize);
                if (!(chunkIdx in this._requestedChunks)) {
                    this._requestedChunks[chunkIdx] = {
                        requestedFrames: new Set(),
                        resolve: null,
                        reject: null,
                        buffer: {},
                    };
                }
                this._requestedChunks[chunkIdx].requestedFrames.add(i);
            }

            let bufferedFrames = new Set();

            // Need to decode chunks in sequence
            // eslint-disable-next-line no-async-promise-executor
            return new Promise(async (resolve, reject) => {
                for (const chunkIdx in this._requestedChunks) {
                    if (Object.prototype.hasOwnProperty.call(this._requestedChunks, chunkIdx)) {
                        try {
                            const chunkFrames = await this.requestOneChunkFrames(chunkIdx);
                            if (chunkIdx in this._requestedChunks) {
                                bufferedFrames = new Set([...bufferedFrames, ...chunkFrames]);
                                this._buffer = {
                                    ...this._buffer,
                                    ...this._requestedChunks[chunkIdx].buffer,
                                };
                                delete this._requestedChunks[chunkIdx];
                                if (Object.keys(this._requestedChunks).length === 0) {
                                    resolve(bufferedFrames);
                                }
                            } else {
                                reject(chunkIdx);
                                break;
                            }
                        } catch (error) {
                            reject(error);
                            break;
                        }
                    }
                }
            });
        }

        async makeFillRequest(start, step, count = null) {
            if (!this._activeFillBufferRequest) {
                this._activeFillBufferRequest = true;
                try {
                    await this.fillBuffer(start, step, count);
                    this._activeFillBufferRequest = false;
                } catch (error) {
                    if (typeof (error) === 'number' && error in this._requestedChunks) {
                        this._activeFillBufferRequest = false;
                        throw error;
                    }
                }
            }
        }

        async require(frameNumber, taskID, fillBuffer, frameStep) {
            for (const frame in this._buffer) {
                if (frame < frameNumber
                    || frame >= frameNumber + this._size * frameStep) {
                    delete this._buffer[frame];
                }
            }

            this._required = frameNumber;
            const size = getFrameSize(taskID, frameNumber);
            let frame = new FrameData(size.width, size.height, taskID, frameNumber,
                frameDataCache[taskID].startFrame, frameDataCache[taskID].stopFrame);

            if (frameNumber in this._buffer) {
                frame = this._buffer[frameNumber];
                delete this._buffer[frameNumber];
                const cachedFrames = this.cachedFrames();
                if (fillBuffer && !this._activeFillBufferRequest
                    && this._size > this._chunkSize
                    && cachedFrames.length < this._size / 2) {
                    const maxFrame = cachedFrames ? Math.max(...cachedFrames) : frameNumber;
                    if (maxFrame < this._stopFrame) {
                        this.makeFillRequest(maxFrame + 1, frameStep);
                    }
                }
            } else if (fillBuffer) {
                this.clear();
                try {
                    await this.makeFillRequest(frameNumber, frameStep, fillBuffer ? null : 1);
                } catch (error) {
                    if (error !== 'not needed') {
                        throw error;
                    }
                }

                frame = this._buffer[frameNumber];
            } else {
                this.clear();
            }

            return frame;
        }

        clear() {
            for (const chunkIdx in this._requestedChunks) {
                if (Object.prototype.hasOwnProperty.call(this._requestedChunks, chunkIdx)
                    && this._requestedChunks[chunkIdx].reject) {
                    this._requestedChunks[chunkIdx].reject('not needed');
                }
            }
            this._activeFillBufferRequest = false;
            this._requestedChunks = {};
            this._buffer = {};
        }

        cachedFrames() {
            return Object.keys(this._buffer).map((f) => +f);
        }
    }

    async function getPreview(taskID) {
        return new Promise((resolve, reject) => {
            // Just go to server and get preview (no any cache)
            serverProxy.frames.getPreview(taskID).then((result) => {
                if (isNode) {
                    resolve(global.Buffer.from(result, 'binary').toString('base64'));
                } else if (isBrowser) {
                    const reader = new FileReader();
                    reader.onload = () => {
                        resolve(reader.result);
                    };
                    reader.readAsDataURL(result);
                }
            }).catch((error) => {
                reject(error);
            });
        });
    }

    async function getFrame(taskID, chunkSize, chunkType, mode, frame,
        startFrame, stopFrame, isPlaying, step) {
        if (!(taskID in frameDataCache)) {
            const blockType = chunkType === 'video' ? cvatData.BlockType.MP4VIDEO
                : cvatData.BlockType.ARCHIVE;

            const meta = await serverProxy.frames.getMeta(taskID);
            const mean = meta.frames.reduce((a, b) => a + b.width * b.height, 0)
                / meta.frames.length;
            const stdDev = Math.sqrt(meta.frames.map(
                (x) => Math.pow(x.width * x.height - mean, 2),
            ).reduce((a, b) => a + b) / meta.frames.length);

            // limit of decoded frames cache by 2GB
            const decodedBlocksCacheSize = Math.floor(2147483648 / (mean + stdDev) / 4 / chunkSize)
                || 1;

            frameDataCache[taskID] = {
                meta,
                chunkSize,
                mode,
                startFrame,
                stopFrame,
                provider: new cvatData.FrameProvider(
                    blockType, chunkSize, Math.max(decodedBlocksCacheSize, 9),
                    decodedBlocksCacheSize, 1,
                ),
                frameBuffer: new FrameBuffer(
                    Math.min(180, decodedBlocksCacheSize * chunkSize),
                    chunkSize,
                    stopFrame,
                    taskID,
                ),
                decodedBlocksCacheSize,
                activeChunkRequest: undefined,
                nextChunkRequest: undefined,
            };
            const size = getFrameSize(taskID, frame);
            // actual only for video chunks
            frameDataCache[taskID].provider.setRenderSize(size.width, size.height);
        }

        return frameDataCache[taskID].frameBuffer.require(frame, taskID, isPlaying, step);
    }

    function getRanges(taskID) {
        if (!(taskID in frameDataCache)) {
            return {
                decoded: [],
                buffered: [],
            };
        }

        return {
            decoded: frameDataCache[taskID].provider.cachedFrames,
            buffered: frameDataCache[taskID].frameBuffer.cachedFrames(),
        };
    }

    module.exports = {
        FrameData,
        getFrame,
        getRanges,
        getPreview,
    };
})();
