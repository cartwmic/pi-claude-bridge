# G9 contention probe — concurrency failure-rate table

Date: 2026-06-02T06:44:25.076Z · HOLD_MS=2000 · repeats/level=3 · model=claude-haiku-4-5

| concurrency | runs | passes | fails | failure rate |
|------------:|-----:|-------:|------:|:------------|
| 2 | 3 | 1 | 2 | 2/3 |
| 3 | 3 | 0 | 3 | 3/3 |
| 4 | 3 | 0 | 3 | 3/3 |

## Failure modes
- level 2:
  - run 2 spawn 1: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 3 spawn 1: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
- level 3:
  - run 1 spawn 0: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 1 spawn 1: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 1 spawn 2: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 2 spawn 0: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 2 spawn 1: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 2 spawn 2: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 3 spawn 0: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 3 spawn 1: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 3 spawn 2: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
- level 4:
  - run 1 spawn 0: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 1 spawn 1: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 1 spawn 2: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 1 spawn 3: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 2 spawn 0: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 2 spawn 1: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 2 spawn 2: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 2 spawn 3: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 3 spawn 0: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 3 spawn 1: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 3 spawn 2: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
  - run 3 spawn 3: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
    - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
    - stderr: claude-p: StopTimeout 
