# Review pi-extensible-workflows (v5.5.0, commit 8b609a5)

Review diretta del codice (nessun subagent/workflow), su ~20.100 righe TypeScript in `packages/core`, `packages/cli`, `packages/extensions/{subagents,herdr}`.

## File di questa review

| File | Contenuto |
|------|-----------|
| [01-ripetizioni.md](01-ripetizioni.md) | Duplicazioni concrete, con posizione e rimedio minimo |
| [02-struttura.md](02-struttura.md) | Struttura, dimensioni dei moduli, pulizia |
| [03-tigerstyle.md](03-tigerstyle.md) | Safety / Performance / DX (formato check TigerStyle) |
| [04-typescript.md](04-typescript.md) | Sistema dei tipi: punti forti e margini |
| [05-migliorie-funzionali.md](05-migliorie-funzionali.md) | 3 proposte funzionali |

## Sintesi

Codebase di qualita molto alta e chiaramente deliberata:

- **Igiene tipi eccellente**: `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, ESLint `strictTypeChecked`; **zero `any`**, zero `eslint-disable`, zero non-null assertion, solo 2 `as unknown as` in tutto il codice sorgente.
- **Safety da manuale**: RPC limitato a 10 MB, heartbeat + watchdog sul worker, sandbox VM indurita, scritture atomiche tmp+rename, lease di sessione con liveness del processo, bound espliciti su stringhe/array persistiti.
- **Verifiche eseguite**: `npm run lint` verde su tutti i workspace, `npm run docs:check` verde. Build e test suite non rieseguiti in questa review (release 5.5.0 recente).

I margini reali sono pochi e mirati:

1. **Ripetizioni meccaniche** (01): ~10 mutex a catena di promise scritti a mano, `error instanceof Error ? ...` inline 62 volte nonostante esista `errorText()`, 5 registrazioni tool identiche in `host.ts`, helper di accounting duplicati tra core e subagents.
2. **`host.ts`**: `workflowExtension()` e una funzione da ~1.150 righe con ~30 closure; la parte estraibile con meno rischio e la macchina di consegna foreground/background.
3. **Due punti di crescita non limitata** (03): l'array `events` per i log di run foreground e il replay O(n²) del journal per run con molti agenti.
4. **Un dettaglio di igiene test**: `real-workflow-session.test.ts` risolve la trace dir contro `process.cwd()` e crea `packages/core/packages/core/.tmp/` (ignorata da git, ma e un percorso sbagliato).
