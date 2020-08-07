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
import { basename } from "path";
import {
    Breakpoint,
    BreakpointEvent,
    Event,
    Handles,
    InitializedEvent,
    Logger,
    logger,
    LoggingDebugSession,
    OutputEvent,
    Scope,
    Source,
    StackFrame,
    StoppedEvent,
    TerminatedEvent,
    Thread
} from "vscode-debugadapter";
import { DebugProtocol } from "vscode-debugprotocol";

import { WorkflowDebugAdapter } from "./workflow-debug-adapter";
import { GLSPBreakpoint, WorkflowRuntime } from "./workflow-runtime";



const { Subject } = require('await-notify');


/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** An absolute path to the "program" to debug. */
    program: string;
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean;
    connectType?: string;
    serverPort?: number;
    serverHost?: string;
    serverBase?: string;
    /** enable logging the Debug Adapter Protocol */
    trace?: boolean;
}

export class WorkflowDebugSession extends LoggingDebugSession {

    // we don't support multiple threads, so we can use a hardcoded ID for the default thread
    private static THREAD_ID = 1;

    // a Mock runtime (or debugger)
    private _runtime: WorkflowRuntime;

    private _variableHandles = new Handles<string>();

    private _configurationDone = new Subject();

    private _localScope = 0;

    /**
     * Creates a new debug adapter that is used for one debug session.
     * We configure the default implementation of a debug adapter here.
     */
    public constructor() {
        super("workflow-debug.txt");

        // this debugger uses zero-based lines and columns
        this.setDebuggerLinesStartAt1(false);
        this.setDebuggerColumnsStartAt1(false);

        this._runtime = new WorkflowRuntime();

        // setup event handlers
        this._runtime.on('stopOnEntry', () => {
            this.sendEvent(new StoppedEvent('entry', WorkflowDebugSession.THREAD_ID));
        });
        this._runtime.on('stopOnStep', () => {
            this.sendEvent(new StoppedEvent('step', WorkflowDebugSession.THREAD_ID));
        });
        this._runtime.on('stopOnBreakpoint', () => {
            this.sendEvent(new StoppedEvent('breakpoint', WorkflowDebugSession.THREAD_ID));
        });
        this._runtime.on('stopOnException', () => {
            this.sendEvent(new StoppedEvent('exception', WorkflowDebugSession.THREAD_ID));
        });
        this._runtime.on('breakpointValidated', (bp: GLSPBreakpoint) => {
            this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.verified, id: bp.id }));
        });
        this._runtime.on('output', (category, text, filePath) => {
            const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
            e.body.category = category;
            e.body.source = this.createSource(filePath);
            this.sendEvent(e);
        });
        this._runtime.on('onDebuggerMessage', () => {
            this.sendEvent(new Event('onDebuggerMessage'));
        });
        this._runtime.on('end', () => {
            this.sendEvent(new TerminatedEvent());
        });
    }

    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

        // build and return the capabilities of this debug adapter:
        response.body = response.body || {};

        // the adapter implements the configurationDoneRequest.
        response.body.supportsConfigurationDoneRequest = true;

        // This debug adapter supports function breakpoints.
        response.body.supportsFunctionBreakpoints = false;

        response.body.supportsEvaluateForHovers = false;
        response.body.supportsSetVariable = false;
        response.body.supportsRestartRequest = false;
        response.body.supportsRestartFrame = false;
        response.body.supportsModulesRequest = false;

        // make VS Code to use 'evaluate' when hovering over source
        // response.body.supportsEvaluateForHovers = true;

        // make VS Code to show a 'step back' button
        // response.body.supportsStepBack = true;

        this.sendResponse(response);

        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent());
    }

    /**
     * Called at the end of the configuration sequence.
     * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
     */
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        super.configurationDoneRequest(response, args);

        // notify the launchRequest that configuration has finished
        this._configurationDone.notify();
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

        // make sure to 'Stop' the buffered logging if 'trace' is not set
        logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

        // wait until configuration has finished (and configurationDoneRequest has been called)
        await this._configurationDone.wait(1000);

        const connectType = args.connectType ? args.connectType : "sockets";
        const host = args.serverHost ? args.serverHost : "127.0.0.1";
        const port = args.serverPort ? args.serverPort : 5056;
        const base = args.serverBase ? args.serverBase : "";

        // start the program in the runtime
        this._runtime.start(args.program, !!args.stopOnEntry, connectType, host, port, base);

        this.sendResponse(response);
    }

    protected customRequest(command: string, response: DebugProtocol.Response, args: any): void {

        switch (command) {

            case 'setGLSPBreakpoints':
                this.setGLSPBreakpointsRequest(response, args);
                break;
            default:
                super.customRequest(command, response, args);
        }
    }

    protected setGLSPBreakpointsRequest(response: DebugProtocol.Response, args: any) {
        this._runtime.clearBreakpoints();
        // set new GLSP breakpoints
        const actualBreakpoints = args.breakpoints.map((glspBreakpoint: GLSPBreakpoint) => {
            const { id, verified } = this._runtime.setGLSPBreakpoint(glspBreakpoint);
            const bp = <DebugProtocol.Breakpoint>new Breakpoint(verified);
            bp.id = id;
            return bp;
        });

        response.body = {
            breakpoints: actualBreakpoints
        };
        this._runtime.sendAllBreakpointsToServer();
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

        // runtime supports now threads so just return a default thread.
        response.body = {
            threads: [
                new Thread(WorkflowDebugSession.THREAD_ID, "thread 1")
            ]
        };
        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

        const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
        const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
        const endFrame = startFrame + maxLevels;

        const stk = this._runtime.stack(startFrame, endFrame);

        response.body = {
            stackFrames: stk.frames.map((f: { index: number; name: string; file: string; line: number; }) => new StackFrame(f.index, f.name, this.createSource(f.file))),
            totalFrames: stk.count
        };
        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

        const frameReference = args.frameId;
        const scopes = new Array<Scope>();
        scopes.push(new Scope("Local", this._variableHandles.create("local_" + frameReference), false));
        scopes.push(new Scope("Global", this._variableHandles.create("global_" + frameReference), true));

        this._localScope = scopes[0].variablesReference;

        response.body = {
            scopes: scopes
        };
        this.sendResponse(response);
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {

        const variables = args.variablesReference === this._localScope ? this._runtime.localVariables : this._runtime.globalVariables;

        response.body = {
            variables: variables
        };
        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this._runtime.continue();
        this.sendResponse(response);
    }

    protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
        this._runtime.continue();
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        this._runtime.step();
        this.sendResponse(response);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        this._runtime.stepIn();
        this.sendResponse(response);
    }
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        this._runtime.stepOut();
        this.sendResponse(response);
    }

    protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
        this._runtime.step();

        this.sendResponse(response);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        this._runtime.disconnectFromDebugger();
        this.sendResponse(response);
    }

    // ---- helpers

    private createSource(filePath: string): Source {
        return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, WorkflowDebugAdapter.SourceData);
    }
}

WorkflowDebugSession.run(WorkflowDebugSession);
