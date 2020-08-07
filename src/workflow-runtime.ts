/********************************************************************************
 * Copyright (c) 2019 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
import "reflect-metadata";

import { EventEmitter } from "events";
import { DebugProtocol } from "vscode-debugprotocol";

import { WorkflowDebugAdapter } from "./workflow-debug-adapter";


const Net = require("net");
const Path = require('path');

export interface GLSPBreakpoint {
    id: number;
    name: string;
    path: string;
    verified: boolean;
}

export interface StackEntry {
    id: number;
    line: number;
    name: string;
    file: string;
}

/**
 * A Mock runtime with minimal debugger functionality.
 */
export class WorkflowRuntime extends EventEmitter {


    private debugger = new Net.Socket();
    private _host = '127.0.0.1';
    private _port = 5056;
    private _connectType = 'sockets';
    private _serverBase = '';

    private _localVariables = new Array<DebugProtocol.Variable>();

    public get localVariables() {
        return this._localVariables;
    }

    private _globalVariables = new Array<DebugProtocol.Variable>();
    public get globalVariables() {
        return this._globalVariables;
    }

    private _connected = false;
    private _isValid = true;
    private _isException = false;
    private _continue = false;
    private _currentElement: string;
    private _init = true;

    private _gettingData = false;
    private _dataTotal = 0;
    private _dataReceived = 0;
    private _dataBytes: Buffer;
    // the initial (and one and only) file we are 'debugging'
    private _sourceFile!: string;
    private _localBase = '';

    public get sourceFile() {
        return this._sourceFile;
    }

    private _stackTrace = new Array<StackEntry>();

    private _queuedCommands = new Array<string>();

    private _glspBreakpoints = new Map<string, GLSPBreakpoint[]>();
    private _breakPointMap = new Map<string, Map<string, GLSPBreakpoint>>();

    // since we want to send breakpoint events, we will assign an id to every event
    // so that the frontend can match events with breakpoints.
    private _breakpointId = 1;


    constructor() {
        super();
    }


    /**
     * Start executing the given program.
     */
    public start(program: string, stopOnEntry: boolean, connectType: string,
        host: string, port: number, serverBase = "") {

        this._connectType = connectType;
        this._host = host;
        this._port = port;
        this._serverBase = serverBase;

        if (host === "127.0.0.1") {
            this._serverBase = "";
        }

        // this.loadSource(program);
        // this._currentLine = -1;
        this._sourceFile = program;
        // this.verifyBreakpoints(this._sourceFile);

        this.connectToDebugger();

        if (stopOnEntry) {
            // we step once
            console.log("StopOnEntry");
            this.step('stopOnEntry');
        } else {
            // we just start to run until we hit a breakpoint or an exception
            this.continue();
        }
    }

    public connectToDebugger() {
        if (this._connected) {
            return;
        }

        if (this._connectType === "sockets") {
            // const serverFilename = "example1.wf";
            const timeout = this._host === '127.0.0.1' || this._host === 'localhost' || this._host === '' ? 3.5 : 10;
            this.debugger.setTimeout(timeout * 1000);

            this.debugger.connect(this._port, this._host, () => {
                this._connected = true;
                this.debugger.setEncoding('utf8');
                console.log("Connected to " + this._host + ":" + this._port);

                this._init = false;
                if (this._sourceFile !== '') {
                    const serverFilename = this.getServerPath(this._sourceFile);
                    if (serverFilename !== undefined && serverFilename !== '') {
                        this.sendToServer("file", serverFilename);
                    }
                    this.sendAllBreakpointsToServer();
                }
                for (let i = 0; i < this._queuedCommands.length; i++) {
                    this.sendToServer(this._queuedCommands[i]);
                }
                this._queuedCommands.length = 0;
            });

            this.debugger.on('data', (data: any) => {
                if (!this._gettingData) {
                    const ind = data.toString().indexOf('\n');
                    console.log("index: :" + ind);
                    this._dataTotal = this._dataReceived = 0;
                    if (ind > 0) {
                        this._dataTotal = Number(data.slice(0, ind));
                        console.log("  Received data size: " + this._dataTotal);
                        if (isNaN(this._dataTotal)) {
                            this._dataTotal = 0;
                        }
                    }
                    if (this._dataTotal === 0) {
                        this.processFromDebugger(data);
                        return;
                    }
                    if (data.length > ind + 1) {
                        data = data.slice(ind + 1);
                    } else {
                        data = '';
                    }
                    this._gettingData = true;
                    console.log(" Started collecting data: " + data.toString().substring(0, 4));
                }
                if (this._gettingData) {
                    if (this._dataReceived === 0) {
                        this._dataBytes = data;
                        this._dataReceived = data.length;
                    } else {
                        console.log("  EXTRA. Currently: " + this._dataReceived + ", total: " + this._dataTotal + ", new: " + data.length);
                        const totalLength = this._dataBytes.length + data.length;
                        this._dataBytes = Buffer.concat([this._dataBytes, data], totalLength);
                        this._dataReceived = totalLength;
                    }
                    if (this._dataReceived >= this._dataTotal) {
                        this._dataTotal = this._dataReceived = 0;
                        this._gettingData = false;
                        console.log("  COLLECTED: " + this._dataBytes.toString().substring(0, 4) + "...");
                        this.processFromDebugger(this._dataBytes);
                    }
                }
            });

            this.debugger.on('close', () => {
                this._connected = false;
                console.log('Connection closed');
            });
        }
    }

    public processFromDebugger(data: any) {
        if (!this.isValid()) {
            return;
        }

        const lines = data.split('\n');
        let currLine = 0;
        const command = lines[currLine++];
        let startVarsData = 1;
        let startStackData = 1;

        console.log("command: " + command + "   response: " + lines.toString());


        if (command === 'end') {
            this.disconnectFromDebugger();
            return;
        }

        if (command === 'vars' || command === 'next' || command === 'exc') {
            this._localVariables.length = 0;
            this._globalVariables.length = 0;
        }

        if (command === 'exc') {
            this.sendEvent('stopOnException');
            this._isException = true;
            startVarsData = 2;
            const nbVarsLines = Number(lines[startVarsData]);
            this.fillVars(lines, startVarsData, nbVarsLines);

            startStackData = startVarsData + nbVarsLines + 1;
            this.fillStackTrace(lines, startStackData);

            const msg = lines.length < 2 ? '' : lines[1];
            const headerMsg = 'Exception thrown: ' + msg + ' ';
            if (this._stackTrace.length < 1) {
                console.log(headerMsg);
                this.sendEvent('output', 'stderr', headerMsg, '');
            } else {
                const entry = this._stackTrace[0];
                console.log(headerMsg, entry.file, entry.name);
                this.sendEvent('output', 'stderr', headerMsg, entry.file);
            }
            return;
        }

        if (command === 'next') {
            const filename = this.getLocalPath(lines[currLine++]);
            this.loadSource(filename);
            this._currentElement = lines[currLine++];

            startVarsData = currLine;

            if (this._currentElement != null) {
                if (this._continue) {
                    const bp = this.getBreakpoint(this._currentElement);

                    if (bp) {
                        this.runOnce('stopOnStep');
                    } else {
                        this.sendToServer('continue');
                    }
                } else {

                    this.runOnce('stopOnStep');
                }
            }
        }

        if (command === 'vars' || command === 'next') {
            const nbVarsLines = Number(lines[startVarsData]);
            this.fillVars(lines, startVarsData, nbVarsLines);
            startStackData = startVarsData + nbVarsLines + 1;
        }

        if (command === 'stack' || command === 'next') {
            this.fillStackTrace(lines, startStackData);
        }

    }

    fillVars(lines: string[], startVarsData: number, nbVarsLines: number) {
        let counter = 0;
        for (let i = startVarsData + 1; i < lines.length && counter < nbVarsLines; i++) {
            counter++;
            const line = lines[i];
            const tokens = line.split(':');
            if (tokens.length < 4) {
                continue;
            }
            const name = tokens[0];
            const globLoc = tokens[1];
            const type = tokens[2];
            let value = tokens.slice(3).join(':').trimRight();
            if (type === 'string') {
                value = '"' + value + '"';
            }
            const item = {
                name: name,
                type: type,
                value: value,
                variablesReference: 0
            };
            if (globLoc === '1') {
                this._globalVariables.push(item);
            } else {
                this._localVariables.push(item);
            }
        }
    }

    fillStackTrace(lines: string[], start = 0): void {
        let id = 0;
        this._stackTrace.length = 0;
        for (let i = start; i < lines.length; i += 2) {
            if (i >= lines.length - 1) {
                break;
            }
            const file = this.getLocalPath(lines[i].trim());
            const line = lines[i + 1].trim();
            const entry = <StackEntry>{ id: ++id, line: 0, name: line, file: file };
            this._stackTrace.push(entry);
        }
    }

    public makeInvalid() {
        this._isValid = false;
    }
    public isValid(): boolean {
        return this._isValid;
    }

    disconnectFromDebugger() {
        if (!this.isValid()) {
            return;
        }
        this.sendToServer("bye");
        this._connected = false;
        this._sourceFile = '';
        this.debugger.end();
        this.sendEvent('end');
        this.makeInvalid();
    }

    public sendToServer(command: string, data = "") {
        let message = command;
        if (data !== '' || command.indexOf('|') < 0) {
            message += '|' + data;
        }
        console.log(message + '\n');
        if (!this._connected) {
            this._queuedCommands.push(message);
            return;
        }
        this.debugger.write(message + "\n");
    }

    /**
     * Continue execution to the end/beginning.
     */
    public continue() {
        if (!this.verifyDebug(this._sourceFile)) {
            return;
        }
        this._continue = true;
        this.sendToServer("continue");
    }

    /**
     * Step to the next/previous non empty line.
     */
    public step(event = 'stopOnStep') {
        if (!this.verifyDebug(this._sourceFile)) {
            return;
        }
        this._continue = false;
        if (this._init) {
            this.runOnce(event);
        } else {
            this.sendToServer("step");
        }
    }
    public stepIn(event = 'stopOnStep') {
        if (!this.verifyDebug(this._sourceFile)) {
            return;
        }
        this._continue = false;
        this.sendToServer('stepin');
    }
    public stepOut(event = 'stopOnStep') {
        if (!this.verifyDebug(this._sourceFile)) {
            return;
        }
        this._continue = false;
        this.sendToServer('stepout');
    }

    private verifyException(): boolean {
        if (this._isException) {
            this.disconnectFromDebugger();
            return false;
        }
        return true;
    }

    public verifyDebug(file: string): boolean {
        return this.verifyException() && file !== null &&
            typeof file !== 'undefined' &&
            (file.endsWith(WorkflowDebugAdapter.FileExtension));
    }


    public stack(startFrame: number, endFrame: number): any {

        const frames = new Array<any>();
        for (let i = 0; i < this._stackTrace.length; i++) {
            const entry = this._stackTrace[i];
            frames.push({
                index: entry.id,
                name: entry.name,
                file: entry.file,
                line: entry.line
            });
        }
        if (frames.length === 0) {
            const name = "";
            frames.push({
                index: 1,
                name: name,
                file: this._sourceFile,
                line: 0
            });
        }
        return {
            frames: frames,
            count: this._stackTrace.length
        };
    }

    public sendBreakpointsToServer(path: string) {
        if (!this._connected) {
            return;
        }

        const filename = Path.basename(path);
        path = Path.resolve(path);
        const lower = path.toLowerCase();

        let data = filename;
        const bps = this._glspBreakpoints.get(lower) || [];

        for (let i = 0; i < bps.length; i++) {
            const entry = bps[i].name;
            data += "|" + entry;
        }
        this.sendToServer('setbp', data);
    }

    sendAllBreakpointsToServer() {
        const keys = Array.from(this._glspBreakpoints.keys());
        if (keys.length !== 0) {
            for (let i = 0; i < keys.length; i++) {
                const path = keys[i];
                this.sendBreakpointsToServer(path);
            }
        }
    }

    public setGLSPBreakpoint(breakpoint: any): GLSPBreakpoint {
        const bp = <GLSPBreakpoint>{ id: this._breakpointId++, name: breakpoint.name, path: breakpoint.uri, verified: true };

        let path = breakpoint.uri;
        const char = path.charAt(2);
        if (char === ':') {
            path = path.substring(1);
        }
        path = Path.resolve(path);

        const lower = path.toLowerCase();

        bp.path = lower;
        let bps = this._glspBreakpoints.get(lower);
        if (!bps) {
            bps = new Array<GLSPBreakpoint>();
            this._glspBreakpoints.set(lower, bps);
        }
        bps.push(bp);

        let bpMap = this._breakPointMap.get(lower);
        if (!bpMap) {
            bpMap = new Map<string, GLSPBreakpoint>();
        }
        bpMap.set(breakpoint.name, bp);
        this._breakPointMap.set(lower, bpMap);

        return bp;
    }

    public getBreakpoint(element: string): GLSPBreakpoint | undefined {

        const pathname = Path.resolve(this._sourceFile);
        const lower = pathname.toLowerCase();
        const bpMap = this._breakPointMap.get(lower);
        console.log(this._breakPointMap);
        console.log(bpMap);
        if (!bpMap) {
            return undefined;
        }
        const bp = bpMap.get(element);
        return bp;
    }

    /*
     * Clear all breakpoints for file.
     */
    public clearBreakpoints(): void {
        this._glspBreakpoints.clear();
        this._breakPointMap.clear();
    }

    private loadSource(filename: string) {
        if (filename === null || filename === undefined) {
            return;
        }
        filename = Path.resolve(filename);
        if (this._sourceFile !== null && this._sourceFile !== undefined &&
            this._sourceFile.toLowerCase() === filename.toLowerCase()) {
            return;
        }
        if (this.verifyDebug(filename)) {
            this._sourceFile = filename;
        }
    }

    getServerPath(pathname: string) {
        if (this._serverBase === "") {
            return pathname;
        }
        pathname = pathname.normalize();
        this.setLocalBasePath(pathname);

        const filename = Path.basename(pathname);
        let serverPath = Path.join(this._serverBase, filename);
        serverPath = serverPath.replace(/\\/g, "/");
        return serverPath;
    }

    setLocalBasePath(pathname: string) {

        if (this._localBase !== undefined && this._localBase !== null && this._localBase !== '') {
            return;
        }
        if (pathname === undefined || pathname === null) {
            this._localBase = '';
            return;
        }
        pathname = Path.resolve(pathname);
        this._localBase = Path.dirname(pathname);
    }

    getLocalPath(pathname: string) {
        if (pathname === undefined || pathname === null || pathname === "") {
            return '';
        }

        pathname = pathname.normalize();
        pathname = pathname.replace(/\\/g, "/");
        const filename = Path.basename(pathname);
        this.setLocalBasePath(pathname);

        let localPath = Path.join(this._localBase, filename);
        localPath = localPath.replace(/\\/g, "/");
        return localPath;
    }

    private runOnce(stepEvent?: string) {
        this.fireEventsForElement(this._currentElement, stepEvent);
    }

    private fireEventsForElement(currentElement: string, stepEvent?: string): boolean {

        // is there a breakpoint?
        const bp = this.getBreakpoint(currentElement);
        if (bp) {
            this.sendEvent('stopOnBreakpoint');
            if (!bp.verified) {
                bp.verified = true;
                this.sendEvent('breakpointValidated', bp);
            }
            return true;
        }

        if (stepEvent) {
            this.sendEvent(stepEvent);
            return true;
        }

        return false;
    }

    private sendEvent(event: string, ...args: any[]) {
        setImmediate(_ => {
            this.emit(event, ...args);
        });
    }
}
