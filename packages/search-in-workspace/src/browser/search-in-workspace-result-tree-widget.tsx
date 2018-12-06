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

import { inject, injectable, postConstruct } from 'inversify';
import {
    TreeWidget,
    ContextMenuRenderer,
    CompositeTreeNode,
    ExpandableTreeNode,
    SelectableTreeNode,
    TreeModel,
    TreeNode,
    NodeProps,
    LabelProvider,
    TreeProps,
    TreeExpansionService,
    ApplicationShell,
    DiffUris,
    FOLDER_ICON
} from '@theia/core/lib/browser';
import { Path, CancellationTokenSource, Emitter, Event } from '@theia/core';
import { EditorManager, EditorDecoration, TrackedRangeStickiness, OverviewRulerLane, EditorWidget, ReplaceOperation, EditorOpenerOptions } from '@theia/editor/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileResourceResolver } from '@theia/filesystem/lib/browser';
import { SearchInWorkspaceResult, SearchInWorkspaceOptions } from '../common/search-in-workspace-interface';
import { SearchInWorkspaceService } from './search-in-workspace-service';
import { MEMORY_TEXT } from './in-memory-text-resource';
import URI from '@theia/core/lib/common/uri';
import * as React from 'react';

const ROOT_ID = 'ResultTree';

export interface SearchInWorkspaceRoot extends CompositeTreeNode {
    children: SearchInWorkspaceRootFolderNode[];
}
export namespace SearchInWorkspaceRoot {
    // tslint:disable-next-line:no-any
    export function is(node: any): node is SearchInWorkspaceRoot {
        return CompositeTreeNode.is(node) && node.id === ROOT_ID && node.name === ROOT_ID;
    }
}
export interface SearchInWorkspaceRootFolderNode extends ExpandableTreeNode, SelectableTreeNode { // root folder node
    children: SearchInWorkspaceFileNode[];
    parent: SearchInWorkspaceRoot;
    path: string;
}
export namespace SearchInWorkspaceRootFolderNode {
    // tslint:disable-next-line:no-any
    export function is(node: any): node is SearchInWorkspaceRootFolderNode {
        return ExpandableTreeNode.is(node) && SelectableTreeNode.is(node) && 'path' in node && !('file' in node);
    }
}

export interface SearchInWorkspaceFileNode extends ExpandableTreeNode, SelectableTreeNode { // file node
    children: SearchInWorkspaceResultLineNode[];
    parent: SearchInWorkspaceRootFolderNode;
    path: string;
    file: string;
}
export namespace SearchInWorkspaceFileNode {
    // tslint:disable-next-line:no-any
    export function is(node: any): node is SearchInWorkspaceFileNode {
        return ExpandableTreeNode.is(node) && SelectableTreeNode.is(node) && 'path' in node && 'file' in node;
    }
}

export interface SearchInWorkspaceResultLineNode extends SelectableTreeNode, SearchInWorkspaceResult { // line node
    parent: SearchInWorkspaceFileNode
}
export namespace SearchInWorkspaceResultLineNode {
    // tslint:disable-next-line:no-any
    export function is(node: any): node is SearchInWorkspaceResultLineNode {
        return SelectableTreeNode.is(node) && 'line' in node && 'character' in node && 'lineText' in node;
    }

    // tslint:disable-next-line:no-any
    export function equal(one: any, other: any): boolean {
        if (is(one) && is(other)) {
            return one.line === other.line && one.character === other.character && one.lineText === other.lineText;
        }
        return false;
    }
}

@injectable()
export class SearchInWorkspaceResultTreeWidget extends TreeWidget {

    protected resultTree: Map<string, SearchInWorkspaceRootFolderNode>;

    protected _showReplaceButtons = false;
    protected _replaceTerm = '';
    protected searchTerm = '';

    protected appliedDecorations = new Map<string, string[]>();

    private cancelIndicator = new CancellationTokenSource();

    protected changeEmitter = new Emitter<Map<string, SearchInWorkspaceRootFolderNode>>();
    // tslint:disable-next-line:no-any
    protected focusInputEmitter = new Emitter<any>();

    @inject(SearchInWorkspaceService) protected readonly searchService: SearchInWorkspaceService;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(FileResourceResolver) protected readonly fileResourceResolver: FileResourceResolver;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(LabelProvider) protected readonly labelProvider: LabelProvider;
    @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService;
    @inject(TreeExpansionService) protected readonly expansionService: TreeExpansionService;

    constructor(
        @inject(TreeProps) readonly props: TreeProps,
        @inject(TreeModel) readonly model: TreeModel,
        @inject(ContextMenuRenderer) protected readonly contextMenuRenderer: ContextMenuRenderer
    ) {
        super(props, model, contextMenuRenderer);

        model.root = {
            id: ROOT_ID,
            name: ROOT_ID,
            parent: undefined,
            visible: false,
            children: []
        } as SearchInWorkspaceRoot;

        this.toDispose.push(model.onSelectionChanged(nodes => {
            const node = nodes[0];
            if (SearchInWorkspaceResultLineNode.is(node)) {
                this.doOpen(node, true);
            }
        }));

        this.resultTree = new Map<string, SearchInWorkspaceRootFolderNode>();
        this.toDispose.push(model.onNodeRefreshed(() => this.changeEmitter.fire(this.resultTree)));
    }

    @postConstruct()
    protected init() {
        super.init();
        this.addClass('resultContainer');

        this.toDispose.push(this.changeEmitter);
        this.toDispose.push(this.focusInputEmitter);

        this.toDispose.push(this.editorManager.onActiveEditorChanged(() => {
            this.updateCurrentEditorDecorations();
        }));
    }

    get fileNumber(): number {
        let num = 0;
        for (const rootFolderNode of this.resultTree.values()) {
            num += rootFolderNode.children.length;
        }
        return num;
    }

    set showReplaceButtons(srb: boolean) {
        this._showReplaceButtons = srb;
        this.update();
    }

    set replaceTerm(rt: string) {
        this._replaceTerm = rt;
        this.update();
    }

    get onChange(): Event<Map<string, SearchInWorkspaceRootFolderNode>> {
        return this.changeEmitter.event;
    }

    get onFocusInput(): Event<void> {
        return this.focusInputEmitter.event;
    }

    collapseAll() {
        this.resultTree.forEach(rootFolderNode => {
            if (rootFolderNode.visible) {
                this.expansionService.collapseNode(rootFolderNode);
            } else {
                rootFolderNode.children.forEach(fileNode => this.expansionService.collapseNode(fileNode));
            }
        });
    }

    async search(searchTerm: string, searchOptions: SearchInWorkspaceOptions): Promise<void> {
        this.searchTerm = searchTerm;
        this.resultTree.clear();
        this.cancelIndicator.cancel();
        this.cancelIndicator = new CancellationTokenSource();
        const token = this.cancelIndicator.token;
        if (searchTerm === '') {
            this.refreshModelChildren();
            return;
        }
        const searchId = await this.searchService.search(searchTerm, {
            onResult: async (aSearchId: number, result: SearchInWorkspaceResult) => {
                if (token.isCancellationRequested || aSearchId !== searchId) {
                    return;
                }
                const { name, path } = this.filenameAndPath(result.root, result.file);
                const tree = this.resultTree;
                const rootFolderNode = tree.get(result.root);

                if (rootFolderNode) {
                    const fileNode = rootFolderNode.children.find(f => f.file === result.file);
                    if (fileNode) {
                        const line = this.createResultLineNode(result, fileNode);
                        if (fileNode.children.findIndex(lineResult => SearchInWorkspaceResultLineNode.equal(lineResult, line)) < 0) {
                            fileNode.children.push(line);
                            if (fileNode.children.length >= 20 && fileNode.expanded) {
                                fileNode.expanded = false;
                            }
                        }
                    } else {
                        const newFileNode = await this.createFileNode(result.root, name, path, result.file, rootFolderNode);
                        const line = this.createResultLineNode(result, newFileNode);
                        newFileNode.children.push(line);
                        rootFolderNode.children.push(newFileNode);
                    }

                } else {
                    const newRootFolderNode = this.createRootFolderNode(result.root);
                    tree.set(result.root, newRootFolderNode);

                    const newFileNode = await this.createFileNode(result.root, name, path, result.file, newRootFolderNode);
                    newFileNode.children.push(this.createResultLineNode(result, newFileNode));
                    newRootFolderNode.children.push(newFileNode);
                }
            },
            onDone: () => {
                if (token.isCancellationRequested) {
                    return;
                }
                this.refreshModelChildren();
            }
        }, searchOptions).catch(e => { return; });
        token.onCancellationRequested(() => {
            if (searchId) {
                this.searchService.cancel(searchId);
            }
        });
    }

    focusFirstResult() {
        if (SearchInWorkspaceRoot.is(this.model.root) && this.model.root.children.length > 0) {
            const node = this.model.root.children[0];
            if (SelectableTreeNode.is(node)) {
                this.node.focus();
                this.model.selectNode(node);
            }
        }
    }

    protected handleUp(event: KeyboardEvent): void {
        if (!this.model.getPrevSelectableNode(this.model.selectedNodes[0])) {
            this.focusInputEmitter.fire(true);
        } else {
            super.handleUp(event);
        }
    }

    protected refreshModelChildren() {
        if (SearchInWorkspaceRoot.is(this.model.root)) {
            this.model.root.children = Array.from(this.resultTree.values());
            this.model.refresh();
            this.updateCurrentEditorDecorations();
        }
    }

    protected updateCurrentEditorDecorations() {
        this.shell.allTabBars.map(tb => {
            const currentTitle = tb.currentTitle;
            if (currentTitle && currentTitle.owner instanceof EditorWidget) {
                const widget = currentTitle.owner;
                const fileNodes = this.getFileNodesByUri(widget.editor.uri);
                fileNodes.forEach(node => {
                    this.decorateEditor(node, widget);
                });
            }
        });

        const currentWidget = this.editorManager.currentEditor;
        if (currentWidget) {
            const fileNodes = this.getFileNodesByUri(currentWidget.editor.uri);
            fileNodes.forEach(node => {
                this.decorateEditor(node, currentWidget);
            });
        }
    }

    protected createRootFolderNode(rootUri: string): SearchInWorkspaceRootFolderNode {
        const uri = new URI(rootUri);
        return {
            selected: false,
            name: uri.displayName,
            path: uri.path.toString(),
            children: [],
            expanded: true,
            id: rootUri,
            parent: this.model.root as SearchInWorkspaceRoot,
            icon: FOLDER_ICON,
            visible: this.workspaceService.workspace && !this.workspaceService.workspace.isDirectory
        };
    }

    protected async createFileNode(rootUri: string, name: string, path: string, file: string, parent: SearchInWorkspaceRootFolderNode): Promise<SearchInWorkspaceFileNode> {
        return {
            selected: false,
            name,
            path,
            children: [],
            expanded: true,
            id: `${rootUri}::${file}`,
            parent,
            icon: await this.labelProvider.getIcon(new URI(file).withScheme('file')),
            file
        };
    }

    protected createResultLineNode(result: SearchInWorkspaceResult, fileNode: SearchInWorkspaceFileNode): SearchInWorkspaceResultLineNode {
        return {
            ...result,
            selected: false,
            id: `${fileNode.id}::${result.line}-${result.character}-${result.length}`,
            name: result.lineText,
            parent: fileNode
        };
    }

    protected getFileNodesByUri(uri: URI): SearchInWorkspaceFileNode[] {
        const nodes: SearchInWorkspaceFileNode[] = [];
        const path = uri.withoutScheme().toString();
        for (const rootFolderNode of this.resultTree.values()) {
            const rootUri = new URI(rootFolderNode.path).withScheme('file');
            if (rootUri.isEqualOrParent(uri)) {
                for (const fileNode of rootFolderNode.children) {
                    if (fileNode.file === path) {
                        nodes.push(fileNode);
                    }
                }
            }
        }
        return nodes;
    }

    protected getFileNodesByLineNode(lineNode: SearchInWorkspaceResultLineNode): SearchInWorkspaceFileNode[] {
        const nodes: SearchInWorkspaceFileNode[] = [];

        return nodes;
    }

    protected filenameAndPath(rootUri: string, uriStr: string): { name: string, path: string } {
        const fileUri: URI = new URI(uriStr);
        const name = fileUri.displayName;
        const rootPath = new URI(rootUri).path.toString();
        const path = new Path(fileUri.path.toString().substr(rootPath.length + 1)).dir.toString();
        return { name, path };
    }

    protected renderCaption(node: TreeNode, props: NodeProps): React.ReactNode {
        if (SearchInWorkspaceRootFolderNode.is(node)) {
            return this.renderRootFolderNode(node);
        } else if (SearchInWorkspaceFileNode.is(node)) {
            return this.renderFileNode(node);
        } else if (SearchInWorkspaceResultLineNode.is(node)) {
            return this.renderResultLineNode(node);
        }
        return '';
    }

    protected renderTailDecorations(node: TreeNode, props: NodeProps): React.ReactNode {
        if (!SearchInWorkspaceRootFolderNode.is(node)) {
            return <div className='result-node-buttons'>
                {this._showReplaceButtons && this.renderReplaceButton(node)}
                {this.renderRemoveButton(node)}
            </div>;
        }
        return '';
    }

    protected readonly replace = (node: TreeNode, e: React.MouseEvent<HTMLElement>) => this.doReplace(node, e);
    protected async doReplace(node: TreeNode, e: React.MouseEvent<HTMLElement>) {
        this.replaceResult(node);
        this.removeNode(node);
        e.stopPropagation();
    }

    protected renderReplaceButton(node: TreeNode): React.ReactNode {
        return <span className='replace-result' onClick={e => this.replace(node, e)}></span>;
    }

    replaceAll(): void {
        this.resultTree.forEach(async resultNode => {
            await this.replaceResult(resultNode);
        });
        this.resultTree.clear();
        this.refreshModelChildren();
    }

    protected updateRightResults(node: SearchInWorkspaceResultLineNode) {
        const fileNode = node.parent;
        const rightPositionedNodes = fileNode.children.filter(rl => rl.line === node.line && rl.character > node.character);
        const diff = this._replaceTerm.length - this.searchTerm.length;
        rightPositionedNodes.map(r => r.character += diff);
    }

    protected async replaceResult(node: TreeNode) {
        const toReplace: SearchInWorkspaceResultLineNode[] = [];
        if (SearchInWorkspaceFileNode.is(node)) {
            toReplace.push(...node.children);
        } else if (SearchInWorkspaceResultLineNode.is(node)) {
            toReplace.push(node);
            this.updateRightResults(node);
        }

        if (toReplace.length > 0) {
            const widget = await this.doOpen(toReplace[0]);
            const source = widget.editor.document.getText();
            const replaceOperations = toReplace.map(resultLineNode => ({
                text: this._replaceTerm,
                range: {
                    start: {
                        line: resultLineNode.line - 1,
                        character: resultLineNode.character - 1
                    },
                    end: {
                        line: resultLineNode.line - 1,
                        character: resultLineNode.character - 1 + resultLineNode.length
                    }
                }
            } as ReplaceOperation));
            await widget.editor.replaceText({
                source,
                replaceOperations
            });
        }
    }

    protected readonly remove = (node: TreeNode, e: React.MouseEvent<HTMLElement>) => this.doRemove(node, e);
    protected doRemove(node: TreeNode, e: React.MouseEvent<HTMLElement>) {
        this.removeNode(node);
        e.stopPropagation();
    }

    protected renderRemoveButton(node: TreeNode): React.ReactNode {
        return <span className='remove-node' onClick={e => this.remove(node, e)}></span>;
    }

    protected removeNode(node: TreeNode): void {
        if (SearchInWorkspaceFileNode.is(node)) {
            this.removeFileNode(node);
        } else if (SearchInWorkspaceResultLineNode.is(node)) {
            const fileNode = node.parent;
            const index = fileNode.children.findIndex(n => n.file === node.file && n.line === node.line && n.character === node.character);
            if (index > -1) {
                fileNode.children.splice(index, 1);
                if (fileNode.children.length === 0) {
                    this.removeFileNode(fileNode);
                }
            }
        }
        this.refreshModelChildren();
    }

    private removeFileNode(node: SearchInWorkspaceFileNode): void {
        const rootFolderNode = node.parent;
        const index = rootFolderNode.children.findIndex(fileNode => fileNode.id === node.id);
        if (index > -1) {
            rootFolderNode.children.splice(index, 1);
        }
    }

    protected renderRootFolderNode(node: SearchInWorkspaceRootFolderNode): React.ReactNode {
        const icon = node.icon;
        return <div className='result'>
            <div className='result-head'>
                <div className={`result-head-info noWrapInfo noselect ${node.selected ? 'selected' : ''}`}>
                    <span className={`file-icon ${icon || ''}`}></span>
                    <span className={'file-name'}>
                        {node.name}
                    </span>
                    <span className={'file-path'}>
                        {node.path}
                    </span>
                </div>
                <span className='notification-count-container'>
                    <span className='notification-count'>
                        {node.children.length}
                    </span>
                </span>
            </div>
        </div>;
    }

    protected renderFileNode(node: SearchInWorkspaceFileNode): React.ReactNode {
        const icon = node.icon;
        return <div className='result'>
            <div className='result-head'>
                <div className={`result-head-info noWrapInfo noselect ${node.selected ? 'selected' : ''}`}>
                    <span className={`file-icon ${icon || ''}`}></span>
                    <span className={'file-name'}>
                        {node.name}
                    </span>
                    <span className={'file-path'}>
                        {node.path}
                    </span>
                </div>
                <span className='notification-count-container'>
                    <span className='notification-count'>
                        {node.children.length}
                    </span>
                </span>
            </div>
        </div>;
    }

    protected renderResultLineNode(node: SearchInWorkspaceResultLineNode): React.ReactNode {
        const prefix = node.character > 26 ? '... ' : '';
        return <div className={`resultLine noWrapInfo ${node.selected ? 'selected' : ''}`}>
            <span>
                {prefix + node.lineText.substr(0, node.character - 1).substr(-25)}
            </span>
            {this.renderMatchLinePart(node)}
            <span>
                {node.lineText.substr(node.character - 1 + node.length, 75)}
            </span>
        </div>;
    }

    protected renderMatchLinePart(node: SearchInWorkspaceResultLineNode): React.ReactNode {
        const replaceTerm = this._replaceTerm !== '' && this._showReplaceButtons ? <span className='replace-term'>{this._replaceTerm}</span> : '';
        const className = `match${this._showReplaceButtons ? ' strike-through' : ''}`;
        return <React.Fragment>
            <span className={className}> {node.lineText.substr(node.character - 1, node.length)}</span>
            {replaceTerm}
        </React.Fragment>;
    }

    protected async doOpen(node: SearchInWorkspaceResultLineNode, preview: boolean = false): Promise<EditorWidget> {
        let fileUri: URI;
        const resultNode = node.parent;
        if (resultNode && this._showReplaceButtons && preview) {
            const leftUri = new URI(node.file).withScheme('file');
            const rightUri = await this.createReplacePreview(resultNode);
            fileUri = DiffUris.encode(leftUri, rightUri);
        } else {
            fileUri = new URI(node.file).withScheme('file');
        }

        const opts: EditorOpenerOptions | undefined = !DiffUris.isDiffUri(fileUri) ? {
            selection: {
                start: {
                    line: node.line - 1,
                    character: node.character - 1
                },
                end: {
                    line: node.line - 1,
                    character: node.character - 1 + node.length
                }
            },
            mode: 'reveal'
        } : undefined;

        const editorWidget = await this.editorManager.open(fileUri, opts);

        if (!DiffUris.isDiffUri(fileUri)) {
            this.decorateEditor(resultNode, editorWidget);
        }

        return editorWidget;
    }

    protected async createReplacePreview(node: SearchInWorkspaceFileNode): Promise<URI> {
        const fileUri = new URI(node.file).withScheme('file');
        const uri = fileUri.withoutScheme().toString();
        const resource = await this.fileResourceResolver.resolve(fileUri);
        const content = await resource.readContents();

        const lines = content.split('\n');
        node.children.map(l => {
            const leftPositionedNodes = node.children.filter(rl => rl.line === l.line && rl.character < l.character);
            const diff = (this._replaceTerm.length - this.searchTerm.length) * leftPositionedNodes.length;
            const start = lines[l.line - 1].substr(0, l.character - 1 + diff);
            const end = lines[l.line - 1].substr(l.character - 1 + diff + l.length);
            lines[l.line - 1] = start + this._replaceTerm + end;
        });

        return new URI(uri).withScheme(MEMORY_TEXT).withQuery(lines.join('\n'));
    }

    protected decorateEditor(node: SearchInWorkspaceFileNode | undefined, editorWidget: EditorWidget) {
        if (!DiffUris.isDiffUri(editorWidget.editor.uri)) {
            const key = `${editorWidget.editor.uri.toString()}#search-in-workspace-matches`;
            const oldDecorations = this.appliedDecorations.get(key) || [];
            const newDecorations = this.createEditorDecorations(node);
            const appliedDecorations = editorWidget.editor.deltaDecorations({
                newDecorations,
                oldDecorations,
            });
            this.appliedDecorations.set(key, appliedDecorations);
        }
    }

    protected createEditorDecorations(resultNode: SearchInWorkspaceFileNode | undefined): EditorDecoration[] {
        const decorations: EditorDecoration[] = [];
        if (resultNode) {
            resultNode.children.map(res => {
                decorations.push({
                    range: {
                        start: {
                            line: res.line - 1,
                            character: res.character - 1
                        },
                        end: {
                            line: res.line - 1,
                            character: res.character - 1 + res.length
                        }
                    },
                    options: {
                        overviewRuler: {
                            color: 'rgba(230, 0, 0, 1)',
                            position: OverviewRulerLane.Full
                        },
                        className: res.selected ? 'current-search-in-workspace-editor-match' : 'search-in-workspace-editor-match',
                        stickiness: TrackedRangeStickiness.GrowsOnlyWhenTypingBefore
                    }
                });
            });
        }
        return decorations;
    }
}
