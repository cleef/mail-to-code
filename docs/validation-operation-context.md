# Operation context refresh validation

Validated on 2026-10-06 with Node.js 22.23.2 and Linux Codex CLI 0.159.2.
All test repositories, mail inputs and operation scripts are synthetic.

- Full regression: 235 passing tests on macOS and Linux.
- Unit/integration checks cover thread resume, active-turn steering, interrupted
  turn recovery, refreshed configuration, approved project isolation, unchanged
  original mail, invalidated exact deployment requests and rejected use of runtime
  facts as write-authorization evidence. The four-conversation limit includes
  dispatches awaiting configuration refresh.
- Real CLI comparison seeds a persisted thread with earlier capability notes and
  without the new native operation tools. On the previous controller, its resumed
  model executed no inspection. With current controller operation context in the
  turn input, the model discovered the fixed compatibility entry and successfully
  ran the synthetic local inspection once, recording its receipt in FEATURE.md.
- The same native thread and approved scope were preserved. Neither run sent real
  email or performed backup, merge or deployment; the repaired run queued no email.

Reproduce using supported Node.js 22:

```sh
npm ci
npm test
# Linux, required Codex CLI installed:
node scripts/verify-operation-resume.mjs
```

`--observe` records model behavior without requiring successful discovery, for
comparison against the earlier implementation. Real model behavior can vary;
durable permission, evidence and fingerprint enforcement remains in the controller.
This validation does not upgrade a running installation or requeue old inputs.
