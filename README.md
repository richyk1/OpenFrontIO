# OpenFrontIO (RL Training Fork)

This is a minimal fork of [OpenFrontIO](https://github.com/openfrontio/OpenFrontIO) containing only the core game engine required for reinforcement learning training.

## What's Included

```
src/core/           Core game engine
resources/maps/     Map binary files and manifests
resources/QuickChat.json
```

## What's Removed

This fork removes everything not needed for headless game execution:
- Client-side rendering (`src/client/`)
- Server multiplayer code (`src/server/`)
- Tests, CI/CD, deployment scripts
- Static web assets, cosmetics, sounds

## Modifications for RL

Memory leak fixes for long-running training sessions:

| File | Change |
|------|--------|
| `GameRunner.ts` | Clear processed turns after execution |
| `GameImpl.ts` | Call `cleanupExpiredData()` every 100 ticks |
| `PlayerImpl.ts` | New cleanup method for expired alliance requests, donations, emojis, targets |

These fixes are essential for RL training which runs thousands of episodes.

## Usage with openfront-deno

This repo is used by [openfront-deno](../openfront-deno) to build the game bundle:

```bash
# Install dependencies
npm install

# Build is done from openfront-deno/js/
cd ../openfront-deno/js
node build.mjs  # Creates bundle.js
```

## License

- Code: [AGPL v3](LICENSE)
- Assets: [CC BY-SA 4.0](LICENSE-ASSETS)

Original project: https://github.com/openfrontio/OpenFrontIO
