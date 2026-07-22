# Migrating from @pi-stef/superpowers-adapter

`@pi-stef/superpowers-adapter` is deprecated. obra/superpowers v6 now provides
native Pi support (skill registration and the `using-superpowers` bootstrap
injection), so the adapter bridge is no longer needed.

## What to do

1. Uninstall the adapter:
   ```bash
   pi uninstall npm:@pi-stef/superpowers-adapter
   ```
2. Install obra/superpowers v6 (if not already):
   ```bash
   pi install git:github.com/obra/superpowers
   ```
3. pair and team (both deprecated → flow) declare obra/superpowers as a `pi.companions`, so installing
   either via the catalog also installs it.

## Why

The adapter auto-injected `using-superpowers` into the system prompt and
provided `Skill`/`TodoWrite` tools. obra v6 injects the bootstrap itself and
Pi loads skills natively — running both would double-inject the bootstrap.
