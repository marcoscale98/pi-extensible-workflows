# TypeScript

## Punti forti (riferimento, non retorica)

- **Config massima utile**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noEmitOnError`; ESLint `strictTypeChecked` senza un solo `eslint-disable`. Nel sorgente: 0 `any`, 0 `!`, 2 `as unknown as` (entrambi al confine con API native di Pi, localizzati e motivati).
- **Discriminated union esaustive**: `RpcMessage` in `execution.ts` con guard `isRpcMessage` che valida ogni variante; stati run/agent derivati da tuple `as const` (`RUN_STATES[number]`), quindi una variante nuova propaga per tipo.
- **Overload ben usati**: `encoded()` con overload `asserts value is JsonValue` (`execution.ts:414-416`) — assertion function da manuale; `atomicWriteFile` sync/async distinti per overload; `parseSettings(path, partial)` con overload sul letterale booleano.
- **Brand a runtime senza inquinare i tipi**: `WORKFLOW_AUTHORED_ERROR` e `MODEL_ALIAS_ERROR_NAME` come `Symbol` non enumerabili (`utils.ts`) — metadati d'errore che sopravvivono al wrap senza estendere classi.
- **Generics con `NoInfer`**: `defineWorkflowFunction` e `AgentOptions<Schema>`+`Static<Schema>` legano schema TypeBox e tipo di ritorno dell'agente. Uso corretto e moderno.
- **Confine `unknown` rispettato**: tutto cio che arriva da disco/IPC passa da `decoders.ts` o dai guard (`object`, `jsonValue`); `catch` sempre come `unknown` con narrow.

## Margini

### T1. L'index signature di `AgentOptions` neutralizza il typo-check

`types.ts:52-64`:
```ts
export interface AgentOptions<Schema extends TSchema = never> {
  label?: string; model?: string; ... retries?: number; timeoutMs?: number | null;
  [key: string]: JsonValue | NoInfer<Schema>;
}
```
L'index signature serve al passthrough verso `agentOptions` persistiti, ma rende `agent(p, { retires: 3 })` o `{ timeouts: 5000 }` **ben tipato**: l'opzione sbagliata viene accettata in silenzio. E il punto piu esposto dell'API pubblica (gli script workflow la usano di continuo).

Mitigazione runtime: `validateAgentOptions` fa il controllo dei nomi lato worker — quindi il buco e solo compile-time per chi usa il contesto tipato (`WorkflowFunctionContext`). Opzioni, in ordine di costo:
1. Documentare che le chiavi extra sono riservate al passthrough (costo zero).
2. In una major: togliere l'index signature e accettare le extra in un campo dedicato (`extra?: Record<string, JsonValue>`), o tipare `agent` con un generico `<O extends AgentOptions>(..., options: Exact<O>)`.

### T2. Vocabolari ripetuti invece che derivati

`ModelSpec.thinking` e un'unione inline in `types.ts`, ridichiarata come alias locale in `agent-execution.ts:9`, come lista in `utils.ts` (`THINKING_LEVELS`) e in `decoders.ts` (`isThinking`). Stessa cosa per `isWorkflowErrorCode` (3 definizioni) e per la lista stati in `isOwnershipState`. Il progetto conosce gia il pattern giusto (`RUN_STATES` -> `RunState`): applicarlo anche qui. (Dettagli in 01-ripetizioni, R9.)

### T3. Alias di tipo senza distinzione

`decoders.ts:6-7`:
```ts
export type PersistedRun = RunRecord;
export type LoadedPersistedRun = PersistedRun;
```
Due nomi per lo stesso tipo suggeriscono una distinzione (validato vs no) che il type system non fa rispettare: una funzione che pretende `LoadedPersistedRun` accetta qualunque `RunRecord`. O si branda il tipo caricato (`RunRecord & { readonly __validated: unique symbol }` restituito solo da `decodePersistedRun`), o si tiene un solo nome. La versione brandata sarebbe coerente con il resto del design; quella a nome unico e la piu lazy. Entrambe meglio dello stato attuale.

### T4 (area grigia). `decoders.ts` a mano vs TypeBox gia in dipendenza

~590 righe di decoder scritti a mano, mentre `typebox` + `Compile` sono gia usati (`agent-execution.ts` per gli output schema, `host.ts` per i parametri dei tool). Derivare i decoder da schemi TypeBox taglierebbe ~300-400 righe e unificherebbe la validazione. Contro: i decoder attuali sono piu precisi sull'interazione con `exactOptionalPropertyTypes` (distinzione assente/undefined), producono `undefined` invece di eccezioni, e non hanno costi di compilazione runtime aggiuntivi. **Non e un difetto**: e una scelta difendibile. Da riconsiderare solo se i formati persistiti iniziano a cambiare spesso.

### T5. `WorkflowOrchestrationContext.pipeline` e `checkpoint` tipati come `(...args: readonly unknown[])`

`types.ts:131`: `parallel` ha un tipo preciso (mapped type sui task), ma `pipeline` e `checkpoint` degradano a `unknown[]` -> `Promise<JsonValue|boolean>`. Per l'autore di workflow functions questo significa zero aiuto dall'editor sulle due API piu articolate. `pipeline(name, items, stages)` e tipizzabile con lo stesso schema di `parallel` (mapped type sugli stage con threading del valore); `checkpoint` con `(input: CheckpointInput) => Promise<boolean>`. Miglioria a solo beneficio DX, nessun impatto runtime.
