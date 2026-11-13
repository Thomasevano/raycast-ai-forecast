# ADR 0001: Preserve native BSD flock coordination

The TypeScript engine keeps the stable `state.lock` file and acquires its BSD `flock` through macOS `/usr/bin/lockf` using a descriptor inherited from Node.
Node retains that descriptor until the entire read/modify/notify/write transaction completes, including cancellation cleanup; the helper exits without releasing the parent's lock.
This preserves Python-era coordination without stale directory-lock recovery or a native npm dependency, and ownership releases on process death.
The trade-off is a macOS 15 minimum and a bounded acquisition subprocess: Apple's [macOS 15 source distribution](https://github.com/apple-oss-distributions/distribution-macOS/tree/macos-150/shell_cmds) includes the [descriptor implementation](https://github.com/apple-oss-distributions/shell_cmds/blob/14a2692995de90c2fde0c3c1e639a8c7d9e2312d/lockf/lockf.c), whereas earlier releases lack it.
That implementation busy-spins when a descriptor is contended with a positive timeout, so the engine uses immediate attempts and cancellable 100 ms waits in Node, bounded to 30 seconds.
Isolated native-lock, concurrent-monitor and cancellation scenarios cover the contract. Never unlink or replace the lock file while consumers may be running.
