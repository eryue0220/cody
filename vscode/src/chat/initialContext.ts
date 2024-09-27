import {
    type AuthStatus,
    CodyIDE,
    type ContextItem,
    ContextItemSource,
    type ContextItemTree,
    REMOTE_REPOSITORY_PROVIDER_URI,
    abortableOperation,
    authStatus,
    combineLatest,
    contextFiltersProvider,
    debounceTime,
    displayLineRange,
    displayPathBasename,
    distinctUntilChanged,
    expandToLineRange,
    fromVSCodeEvent,
    isDotCom,
    isError,
    openCtx,
    pendingOperation,
    shareReplay,
    startWith,
    switchMap,
} from '@sourcegraph/cody-shared'
import { Observable, map } from 'observable-fns'
import * as vscode from 'vscode'
import { URI } from 'vscode-uri'
import { getSelectionOrFileContext } from '../commands/context/selection'
import { getConfiguration } from '../configuration'
import { createRepositoryMention } from '../context/openctx/common/get-repository-mentions'
import { workspaceReposMonitor } from '../repository/repo-metadata-from-git-api'
import { ChatBuilder } from './chat-view/ChatBuilder'
import {
    contextItemMentionFromOpenCtxItem,
    getActiveEditorContextForOpenCtxMentions,
} from './context/chatContext'

/**
 * Observe the initial context that should be populated in the chat message input field.
 */
export function observeInitialContext({
    chatBuilder,
}: {
    chatBuilder: Observable<ChatBuilder>
}): Observable<ContextItem[]> {
    return combineLatest([
        getCurrentFileOrSelection({ chatBuilder }).pipe(distinctUntilChanged()),
        getCorpusContextItemsForEditorState().pipe(distinctUntilChanged()),
        getOpenCtxContextItems().pipe(distinctUntilChanged()),
    ]).pipe(
        debounceTime(50),
        switchMap(([currentFileOrSelectionContext, corpusContext, openctxContext]) => {
            return Observable.of([
                ...(openctxContext === pendingOperation ? [] : openctxContext),
                ...(currentFileOrSelectionContext === pendingOperation
                    ? []
                    : currentFileOrSelectionContext),
                ...corpusContext,
            ])
        })
    )
}

const activeTextEditor = fromVSCodeEvent(
    vscode.window.onDidChangeActiveTextEditor,
    () => vscode.window.activeTextEditor
).pipe(shareReplay())

function getCurrentFileOrSelection({
    chatBuilder,
}: { chatBuilder: Observable<ChatBuilder> }): Observable<ContextItem[] | typeof pendingOperation> {
    /**
     * If the active text editor changes, this observable immediately emits.
     *
     * If *only* the active selection changes, it debounces 200ms before emitting so we don't spam a
     * bunch of minor updates as the user is actively moving their cursor or changing their
     * selection.
     */
    const selectionOrFileChanged = activeTextEditor.pipe(
        switchMap(() =>
            fromVSCodeEvent(vscode.window.onDidChangeTextEditorSelection).pipe(
                debounceTime(200),
                startWith(undefined),
                map(() => vscode.window.activeTextEditor?.selection)
            )
        )
    )
    const selectionOrFileContext = selectionOrFileChanged.pipe(
        abortableOperation(() => getSelectionOrFileContext())
    )

    return combineLatest([selectionOrFileContext, ChatBuilder.contextWindowForChat(chatBuilder)]).pipe(
        switchMap(
            ([selectionOrFileContext, contextWindow]): Observable<
                ContextItem[] | typeof pendingOperation
            > => {
                if (contextWindow === pendingOperation) {
                    return Observable.of(pendingOperation)
                }
                const userContextSize = isError(contextWindow)
                    ? undefined
                    : contextWindow.context?.user ?? contextWindow.input

                const items: ContextItem[] = []

                const contextFile = selectionOrFileContext[0]
                if (contextFile) {
                    const range = contextFile.range ? expandToLineRange(contextFile.range) : undefined

                    // Always add the current file item
                    items.push({
                        ...contextFile,
                        type: 'file',
                        title: 'Current File',
                        description: displayPathBasename(contextFile.uri),
                        range: undefined,
                        isTooLarge:
                            userContextSize !== undefined &&
                            contextFile.size !== undefined &&
                            contextFile.size > userContextSize,
                        source: ContextItemSource.Initial,
                        icon: 'file',
                    })

                    // Add the current selection item if there's a range
                    if (range) {
                        items.push({
                            ...contextFile,
                            type: 'file',
                            title: 'Current Selection',
                            description: `${displayPathBasename(contextFile.uri)}:${displayLineRange(
                                range
                            )}`,
                            range,
                            isTooLarge:
                                userContextSize !== undefined &&
                                contextFile.size !== undefined &&
                                contextFile.size > userContextSize,
                            source: ContextItemSource.Initial,
                            icon: 'list-selection',
                        })
                    }
                }
                return Observable.of(items)
            }
        )
    )
}

function getCorpusContextItemsForEditorState(): Observable<ContextItem[]> {
    const relevantAuthStatus = authStatus.pipe(
        map(
            authStatus =>
                ({
                    authenticated: authStatus.authenticated,
                    endpoint: authStatus.endpoint,
                    allowRemoteContext:
                        getConfiguration().agentIDE === CodyIDE.Web || !isDotCom(authStatus),
                }) satisfies Pick<AuthStatus, 'authenticated' | 'endpoint'> & {
                    allowRemoteContext: boolean
                }
        ),
        distinctUntilChanged()
    )

    return relevantAuthStatus.pipe(
        abortableOperation(async (authStatus, signal) => {
            const items: ContextItem[] = []

            // TODO(sqs): Make this consistent between self-serve (no remote search) and enterprise (has
            // remote search). There should be a single internal thing in Cody that lets you monitor the
            // user's current codebase.
            if (authStatus.allowRemoteContext && workspaceReposMonitor) {
                const repoMetadata = await workspaceReposMonitor.getRepoMetadata()
                for (const repo of repoMetadata) {
                    if (await contextFiltersProvider.isRepoNameIgnored(repo.repoName)) {
                        continue
                    }
                    if (repo.remoteID === undefined) {
                        continue
                    }
                    items.push({
                        ...contextItemMentionFromOpenCtxItem(
                            await createRepositoryMention(
                                {
                                    id: repo.remoteID,
                                    name: repo.repoName,
                                    url: repo.repoName,
                                },
                                REMOTE_REPOSITORY_PROVIDER_URI,
                                authStatus
                            )
                        ),
                        title: 'Current Repository',
                        description: repo.repoName,
                        source: ContextItemSource.Initial,
                        icon: 'folder',
                    })
                }
            } else {
                // TODO(sqs): Support multi-root. Right now, this only supports the 1st workspace root.
                const workspaceFolder = vscode.workspace.workspaceFolders?.at(0)
                if (workspaceFolder) {
                    items.push({
                        type: 'tree',
                        uri: workspaceFolder.uri,
                        title: 'Current Repository',
                        name: workspaceFolder.name,
                        description: workspaceFolder.name,
                        isWorkspaceRoot: true,
                        content: null,
                        source: ContextItemSource.Initial,
                        icon: 'folder',
                    } satisfies ContextItemTree)
                }
            }

            return items
        })
    )
}

function getOpenCtxContextItems(): Observable<ContextItem[] | typeof pendingOperation> {
    const openctxController = openCtx.controller
    if (!openctxController) {
        return Observable.of([])
    }

    return openctxController.metaChanges({}).pipe(
        switchMap((providers): Observable<ContextItem[] | typeof pendingOperation> => {
            const providersWithAutoInclude = providers.filter(meta => meta.mentions?.autoInclude)
            if (providersWithAutoInclude.length === 0) {
                return Observable.of([])
            }

            return activeTextEditor.pipe(
                debounceTime(50),
                abortableOperation(() => getActiveEditorContextForOpenCtxMentions()),
                switchMap(activeEditorContext => {
                    return combineLatest(
                        providersWithAutoInclude.map(provider =>
                            openctxController.mentionsChanges(
                                { ...activeEditorContext, autoInclude: true },
                                provider
                            )
                        )
                    ).pipe(
                        map(mentionsResults =>
                            mentionsResults.flat().map(
                                mention =>
                                    ({
                                        ...mention,
                                        provider: 'openctx',
                                        type: 'openctx',
                                        uri: URI.parse(mention.uri),
                                        source: ContextItemSource.Initial,
                                        mention, // include the original mention to pass to `items` later
                                    }) satisfies ContextItem
                            )
                        ),
                        startWith(pendingOperation)
                    )
                })
            )
        })
    )
}