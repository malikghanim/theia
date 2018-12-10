/********************************************************************************
 * Copyright (C) 2018 TypeFox and others.
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

import { injectable, inject } from 'inversify';
import { DebugConfiguration } from '../common/debug-common';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { Disposable } from '@theia/core/lib/common/disposable';
import { DebugService, DebuggerDescription } from '../common/debug-service';
import { IJSONSchema, IJSONSchemaSnippet } from '@theia/core/lib/common/json-schema';
import { Emitter, Event } from '@theia/core/lib/common/event';

/**
 * Manages both extension and plugin debuggers contributions
 */
@injectable()
export class DebugContributionManager {
    protected readonly pluginContributors = new Map<string, DebugPluginContributor>();

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;
    @inject(DebugService)
    protected readonly debugService: DebugService;

    protected readonly onDidContributionAddEmitter = new Emitter<string>();
    readonly onDidContributionAdd: Event<string> = this.onDidContributionAddEmitter.event;
    protected fireDidContributionAdd(debugType: string): void {
        this.onDidContributionAddEmitter.fire(debugType);
    }

    protected readonly onDidContributionDeleteEmitter = new Emitter<string>();
    readonly onDidContributionDelete: Event<string> = this.onDidContributionDeleteEmitter.event;
    protected fireDidContributionDelete(debugType: string): void {
        this.onDidContributionDeleteEmitter.fire(debugType);
    }

    async registerDebugPluginContributor(contributor: DebugPluginContributor): Promise<Disposable> {
        const type = contributor.description.type;
        if (await this.isRegistered(type)) {
            console.warn(`Debugger with type '${type}' already registered.`);
            return Disposable.NULL;
        }

        this.pluginContributors.set(type, contributor);
        this.fireDidContributionAdd(type);
        return Disposable.create(() => this.unregisterDebugPluginContributor(type));
    }

    async unregisterDebugPluginContributor(debugType: string): Promise<void> {
        this.pluginContributors.delete(debugType);
        this.fireDidContributionDelete(debugType);
    }

    async debugTypes(): Promise<string[]> {
        const debugTypes = await this.debugService.debugTypes();
        return debugTypes.concat(Array.from(this.pluginContributors.keys()));
    }

    async provideDebugConfigurations(debugType: string, workspaceFolderUri: string | undefined): Promise<DebugConfiguration[]> {
        const contributor = this.pluginContributors.get(debugType);
        if (contributor) {
            return contributor.provideDebugConfigurations(workspaceFolderUri);
        } else {
            return this.debugService.provideDebugConfigurations(debugType, workspaceFolderUri);
        }
    }

    async resolveDebugConfiguration(config: DebugConfiguration, workspaceFolderUri: string | undefined): Promise<DebugConfiguration> {
        const contributor = this.pluginContributors.get(config.type);
        if (contributor) {
            const resolved = await contributor.resolveDebugConfiguration(config, workspaceFolderUri);
            return resolved || config;
        } else {
            return this.debugService.resolveDebugConfiguration(config, workspaceFolderUri);
        }
    }

    async getDebuggersForLanguage(language: string): Promise<DebuggerDescription[]> {
        const debuggers = await this.debugService.getDebuggersForLanguage(language);

        for (const contributor of this.pluginContributors.values()) {
            const languages = await contributor.getSupportedLanguages();
            if (languages && languages.indexOf(language) !== -1) {
                debuggers.push(contributor.description);
            }
        }

        return debuggers;
    }

    async getSchemaAttributes(debugType: string): Promise<IJSONSchema[]> {
        const contributor = this.pluginContributors.get(debugType);
        if (contributor) {
            return contributor.getSchemaAttributes();
        } else {
            return this.debugService.getSchemaAttributes(debugType);
        }
    }

    async getConfigurationSnippets(): Promise<IJSONSchemaSnippet[]> {
        let snippets = await this.debugService.getConfigurationSnippets();

        for (const contributor of this.pluginContributors.values()) {
            snippets = snippets.concat(await contributor.getConfigurationSnippets());
        }

        return snippets;
    }

    async create(config: DebugConfiguration): Promise<string> {
        const contributor = this.pluginContributors.get(config.type);
        if (contributor) {
            return contributor.createDebugSession(config);
        } else {
            return this.debugService.create(config);
        }
    }

    async stop(debugType: string, sessionId: string): Promise<void> {
        const contributor = this.pluginContributors.get(debugType);
        if (contributor) {
            return contributor.terminateDebugSession();
        } else {
            return this.debugService.stop(sessionId);
        }
    }

    private async isRegistered(debugType: string): Promise<boolean> {
        const registeredTypes = await this.debugTypes();
        return registeredTypes.indexOf(debugType) !== -1;
    }
}

export interface DebugPluginContributor {
    description: DebuggerDescription;

    getSupportedLanguages(): Promise<string[]>;

    getSchemaAttributes(): Promise<IJSONSchema[]>;

    getConfigurationSnippets(): Promise<IJSONSchemaSnippet[]>;

    provideDebugConfigurations(workspaceFolderUri: string | undefined): Promise<DebugConfiguration[]>;

    resolveDebugConfiguration(config: DebugConfiguration, workspaceFolderUri: string | undefined): Promise<DebugConfiguration | undefined>;

    createDebugSession(config: DebugConfiguration): Promise<string>;

    terminateDebugSession(): Promise<void>;
}
