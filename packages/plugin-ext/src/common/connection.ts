/********************************************************************************
 * Copyright (C) 2018 Red Hat, Inc. and others.
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
import { Disposable } from './disposable-util';
import { PluginMessageReader } from './plugin-message-reader';
import { PluginMessageWriter } from './plugin-message-writer';
import { IWebSocket } from 'vscode-ws-jsonrpc/lib/socket/socket';

/**
 * The container for message reader and writer which can be used to create connection between plugins and main side.
 */
export class PluginConnection implements Disposable {
    constructor(
        readonly reader: PluginMessageReader,
        readonly writer: PluginMessageWriter,
        readonly dispose: () => void) {
    }
}

/**
 * [IWebSocket](#IWebSocket) implementation over RPC.
 */
export class PluginWebSocketChannel implements IWebSocket {
    constructor(protected readonly connection: PluginConnection) { }

    send(content: string): void {
        this.connection.writer.write(content);
    }

    onMessage(cb: (data: any) => void): void {
        this.connection.reader.listen(cb);
    }

    onError(cb: (reason: any) => void): void {
        this.connection.reader.onError(e => cb(e));
    }

    onClose(cb: (code: number, reason: string) => void): void {
        this.onClose(cb);
    }

    dispose(): void {
        this.connection.dispose();
    }
}
