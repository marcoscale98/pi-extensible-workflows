# Ripetizioni

Un finding per causa radice. Ordinati per rapporto beneficio/rischio del rimedio.

## R1. Mutex a catena di promise scritto a mano ~10 volte

**Dove**
- `packages/core/src/store.ts:41-57`: 8 campi privati (`journalWrite`, `stateWrite`, `summaryWrite`, `worktreeWrite`, `borrowedWorktreeWrite`, `snapshotWrite`, `launchSnapshotWrite`, `systemPromptWrite`), ciascuno con lo stesso rito:
  ```ts
  const write = this.stateWrite.then(async () => { ... });
  this.stateWrite = write.catch(() => undefined);   // oppure .then(() => undefined, () => undefined)
  await write;
  ```
- `packages/core/src/host.ts` (`enqueueProviderRecovery`, `terminalDeliveryQueues`), `packages/core/src/agent-execution.ts` (`enqueue` in `createLocalWorkflowAgentSession`), `packages/extensions/subagents/src/manager.ts` (`writes` di `LiveRun`).

Il pattern ha anche due varianti divergenti per assorbire il fallimento (`.catch(() => undefined)` vs `.then(() => undefined, () => undefined)`) che fanno la stessa cosa.

**Rimedio minimo**: una classe di ~8 righe in `utils.ts`:
```ts
export class SerialLane {
  #tail: Promise<void> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task, task);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
}
```
`store.ts` scende di ~40 righe e ogni corsia diventa `#stateLane = new SerialLane()`. Nessun cambio di semantica.

## R2. `error instanceof Error ? error.message : String(error)` inline 62 volte

**Dove**: 62 occorrenze fuori dai test (11 solo in `store.ts`, poi `execution.ts`, `cli.ts`, estensioni), nonostante `errorText()` esista in `utils.ts:26` e sia gia esportata dal pacchetto (le estensioni la importano gia).

**Nota semantica**: `errorText()` preferisce `message` anche su oggetti non-Error; per i siti che avvolgono in `new WorkflowError(code, ...)` il comportamento e identico o migliore.

**Rimedio minimo**: sostituzione meccanica con `errorText(error)`. Zero nuove astrazioni.

## R3. Ri-wrap dell'errore con lo stesso codice, 9 volte

**Dove**: `store.ts` (7x per `WORKTREE_FAILED`, 2x per `RESUME_INCOMPATIBLE`):
```ts
throw error instanceof WorkflowError && error.code === "WORKTREE_FAILED"
  ? error : new WorkflowError("WORKTREE_FAILED", errorText(error));
```

**Rimedio minimo** in `utils.ts`:
```ts
export function coerceWorkflowError(code: WorkflowErrorCode, error: unknown): WorkflowError {
  return error instanceof WorkflowError && error.code === code ? error : new WorkflowError(code, errorText(error));
}
```

## R4. Check di identita del run duplicato 5 volte in `store.ts`

**Dove**: `create()`, `load()`, `loadStatus()`, `saveState()`, `updateState()` (2x) ripetono:
```ts
if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError(<codice variabile>, <messaggio variabile>);
```

**Rimedio minimo**: `#assertRunIdentity(run, code, message)` privato. Tiene in un punto solo l'invariante "un RunStore parla solo del proprio run".

## R5. Caricamento + decode di `worktrees.json` ripetuto ~7 volte

**Dove**: `store.ts` — `ownedWorktree`, `findNamedWorktree`, `validateDeletionWorktrees`, `validateNamedWorktrees`, `ownsWorktree`, `worktree`, `worktrees`, `validNamedWorktrees`, `delete` ripetono `decodeWorktreeReferences(await json(join(this.directory, "worktrees.json")))` + gestione ENOENT + throw "Worktree records are invalid" (11 occorrenze di `decodeWorktreeReferences`).

**Rimedio minimo**: `#loadWorktreeRecords(missingOk = true)` privato che centralizza path, ENOENT e l'errore di decodifica.

## R6. 5 registrazioni tool identiche in `host.ts`

**Dove**: `host.ts:742-948` — `workflow_respond`, `workflow_stop`, `workflow_status`, `workflow_retry`, `workflow_resume` condividono byte per byte:
- `renderCall(args, theme) { return styledTextBlock(workflowControlCall(NOME, args, theme)); }`
- `renderResult(...) { return workflowCatalogBlock(workflowControlResult(NOME, ...), options.expanded); }`
- il guscio `try { ... } catch (error) { throw mainAgentError(error); }`
- il risultato `{ content: [{ type: "text", text }], details }`.

**Rimedio minimo**: una factory locale
```ts
const registerControlTool = <P extends TSchema>(name: string, label: string, description: string, parameters: P, run: (params: Static<P>, signal: AbortSignal, ctx: unknown) => Promise<{ text: string; details: unknown }>) => { ... };
```
Toglie ~40 righe e garantisce che un sesto tool di controllo nasca gia coerente.

## R7. Strip delle virgolette ripetuto 5 volte in `parseRoleMarkdown`

**Dove**: `validation.ts:192-207` — `.replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "")` per `parseList`, `thinking`, `model`, `description`, `contextFiles`.

**Rimedio minimo**: `const unquote = (v: string) => v.replace(/^['"]|['"]$/g, "");` locale alla funzione. (Le due regex attuali tolgono anche virgolette non accoppiate, `'x"` -> `x`; una `unquote` che pretende la coppia sarebbe pure piu corretta.)

## R8. Helper di accounting duplicati tra core e subagents

**Dove**
- `execution.ts:585` e `:598`: zero-accounting letterale + reduce di somma inline.
- `manager.ts:386-395` (subagents): `zeroAccounting()`, `addAccounting()`, `sumAccounting()` riscritti.

**Rimedio minimo**: esportare `zeroAccounting`/`addAccounting` dal core (accanto ad `AgentAccounting` in `types.ts`) e usarli in entrambi i posti.

## R9. Type guard e liste di letterali ridefiniti localmente

**Dove**
- `isWorkflowErrorCode`: definita 3 volte (`utils.ts:31`, `execution.ts:15`, `decoders.ts:38`) sempre su `ERROR_CODES`.
- Livelli di thinking `["off","minimal",...]`: `utils.ts` (`THINKING_LEVELS`), `decoders.ts` (`isThinking`), `agent-execution.ts` (type alias locale `ThinkingLevel`), e l'unione inline in `ModelSpec` (`types.ts:...thinking?: "off" | ... | "max"`).
- `finiteNumber`: `decoders.ts:27` e `manager.ts:273`.
- `isOwnershipState` (`decoders.ts`) rideclama a mano la lista che e gia `AGENT_STATES`.

**Rimedio minimo**: `types.ts` esporta `THINKING_LEVELS` + `type ThinkingLevel`, `utils.ts` esporta `isWorkflowErrorCode` e `finiteNumber`; gli altri file importano. Una lista per vocabolario, come gia fatto (bene) per `RUN_STATES`/`HARD_TERMINAL_RUN_STATES`.

## R10. `atomicJson` riscritta nell'estensione subagents

**Dove**: `manager.ts:246` ridefinisce `atomicJson` (con in piu il check di serializzabilita) mentre `core/src/io.ts` la esporta gia e il subpath `pi-extensible-workflows/persistence` gia riesporta `atomicWriteFile` che manager usa.

**Rimedio minimo**: esportare `atomicJson` dal subpath persistence (eventualmente con il check del manager, che e la versione piu sicura) e cancellare la copia.

## R11 (area grigia). Lo spread condizionale `...(x === undefined ? {} : { x })`

252 occorrenze in core. E la conseguenza diretta e corretta di `exactOptionalPropertyTypes`; un helper generico (`definedProps(obj)`) perderebbe precisione di tipo o richiederebbe type-machinery non banale. **Da accettare cosi**; vale solo la pena spezzare i cluster piu densi (es. `resumedSnapshotSettings` in `host.ts`, 10 spread in 2 espressioni) in costruzioni a passi quando si tocca quel codice.
