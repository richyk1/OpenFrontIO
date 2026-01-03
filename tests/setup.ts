/**
 * Global test setup file for Vitest
 *
 * Loads Rust WASM module from openfront-core and patches JS functions
 * to use Rust implementations when available.
 */

import path from "path";
import { beforeAll } from "vitest";

// Type for the Rust WASM module
type RustCore = typeof import("../../../openfront-core/pkg/openfront_core");

// Global state for Rust WASM
declare global {
  var __RUST_WASM_AVAILABLE__: boolean;
  var __RUST_CORE__: RustCore | null;
}

globalThis.__RUST_WASM_AVAILABLE__ = false;
globalThis.__RUST_CORE__ = null;

/**
 * SpawnGameState - matches Rust struct for passing game state
 */
interface SpawnGameState {
  width: number;
  height: number;
  in_spawn_phase: boolean;
  land_data: boolean[];
  owner_data: number[]; // -1 for no owner
  border_data: boolean[];
  player_spawn_tiles: (number | null)[];
  min_distance_between_players: number;
  num_spawn_phase_turns: number;
  current_tick: number;
}

/**
 * SpawnAction - result from Rust tick
 */
interface SpawnAction {
  spawn_tile: number;
  tiles_to_conquer: number[];
  tiles_to_relinquish: number[];
  create_player_execution: boolean;
  create_bot_execution: boolean;
}

/**
 * ClusterGameState - matches Rust struct for cluster calculations
 */
interface ClusterGameState {
  width: number;
  height: number;
  player_id: number;
  owner_data: number[];
  border_tiles: number[];
  shore_tiles: boolean[];
  ocean_shore_tiles: boolean[];
  edge_tiles: boolean[];
  friendly_players: number[];
}

/**
 * ClusterResult - result from Rust calculateClusters
 */
interface ClusterResult {
  clusters: number[][];
  largest_cluster_index: number | null;
  largest_cluster_bbox: [number, number, number, number] | null;
}

/**
 * SurroundedClusterInfo - result from Rust checkSurroundedClusters
 */
interface SurroundedClusterInfo {
  cluster_index: number;
  surrounded_by: number | null;
  should_remove: boolean;
}

/**
 * BotGameState - matches Rust struct for bot tick
 */
interface BotGameState {
  ticks: number;
  bot_alive: boolean;
  bot_troops: number;
  max_troops: number;
  shares_border_with_terra_nullius: boolean;
  traitor_neighbor_ids: string[];
  enemy_neighbor_ids: string[];
}

/**
 * BotTickResult - result from Rust bot tick
 */
interface BotTickResult {
  skip: boolean;
  deactivate: boolean;
  first_tick: boolean;
  attack_target: string | null;
  attack_terra_nullius: boolean;
  attack_random: boolean;
}

/**
 * Load the Rust WASM module from openfront-core
 */
function loadRustCore(): RustCore {
  // Resolve relative to project root (cwd), not __dirname
  const wasmPath = path.resolve(
    process.cwd(),
    "../openfront-core/pkg/openfront_core.js",
  );
  // Use require for Node.js compatibility
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(wasmPath);
}

/**
 * Mapping of JS functions to Rust replacements.
 * Add entries here as Rust implementations become ready.
 */

type AnyFn = (...args: any[]) => any;

/**
 * Async patches that will be applied once modules are loaded.
 * These use dynamic import() to work with TypeScript modules.
 */
interface AsyncPatch {
  modulePath: string;
  className: string;
  method: string;
  patchFn: (rustCore: RustCore, proto: any) => void;
}

const ASYNC_PATCHES: AsyncPatch[] = [
  {
    modulePath: "../src/core/execution/AttackExecution",
    className: "AttackExecution",
    method: "addNeighbors",
    patchFn: (rustCore, proto) => {
      // Patch addNeighbors to use Rust for priority queue and random
      const originalAddNeighbors = proto.addNeighbors;

      proto.addNeighbors = function (this: any, tile: number) {
        // Get or create Rust AttackExecution instance
        this._rustExec ??= new rustCore.AttackExecution(BigInt(123));

        const attack = this.attack;
        const mg = this.mg;
        const target = this.target;
        const owner = this._owner;

        if (!attack || !mg) {
          originalAddNeighbors.call(this, tile);
          return;
        }

        const tickNow = mg.ticks();

        for (const neighbor of mg.neighbors(tile)) {
          if (mg.isWater(neighbor) || mg.owner(neighbor) !== target) {
            continue;
          }
          attack.addBorderTile(neighbor);

          let numOwnedByMe = 0;
          for (const n of mg.neighbors(neighbor)) {
            if (mg.owner(n) === owner) {
              numOwnedByMe++;
            }
          }

          // Use Rust for priority calculation (uses Rust random for determinism)
          const priority = this._rustExec.calculatePriority(
            numOwnedByMe,
            mg.terrainType(neighbor),
            tickNow,
          );

          this.toConquer.enqueue(neighbor, priority);
        }
      };

      proto._originalAddNeighbors = originalAddNeighbors;
    },
  },
  {
    modulePath: "../src/core/execution/PlayerExecution",
    className: "PlayerExecution",
    method: "calculateClusters",
    patchFn: (rustCore, proto) => {
      const originalCalculateClusters = proto.calculateClusters;

      // Patch calculateClusters to use Rust
      proto.calculateClusters = function (this: any): Set<number>[] {
        const mg = this.mg;
        const player = this.player;
        if (!mg || !player) return [];

        const borderTiles = player.borderTiles();
        if (borderTiles.size === 0) return [];

        const width = mg.width();
        const height = mg.height();
        const totalTiles = width * height;

        // Build owner data array
        const ownerData: number[] = new Array(totalTiles);
        for (let i = 0; i < totalTiles; i++) {
          ownerData[i] = mg.hasOwner(i) ? mg.ownerID(i) : -1;
        }

        // Build shore and edge data
        const shoreTiles: boolean[] = new Array(totalTiles);
        const oceanShoreTiles: boolean[] = new Array(totalTiles);
        const edgeTiles: boolean[] = new Array(totalTiles);
        for (let i = 0; i < totalTiles; i++) {
          shoreTiles[i] = mg.isShore(i);
          oceanShoreTiles[i] = mg.isOceanShore(i);
          edgeTiles[i] = mg.isOnEdgeOfMap(i);
        }

        // Get friendly players
        const friendlyPlayers: number[] = [];
        for (const p of mg.allPlayers()) {
          if (p !== player && player.isFriendly(p)) {
            friendlyPlayers.push(p.smallID());
          }
        }

        const gameState: ClusterGameState = {
          width,
          height,
          player_id: player.smallID(),
          owner_data: ownerData,
          border_tiles: Array.from(borderTiles),
          shore_tiles: shoreTiles,
          ocean_shore_tiles: oceanShoreTiles,
          edge_tiles: edgeTiles,
          friendly_players: friendlyPlayers,
        };

        // Call Rust calculateClusters
        const resultJson = rustCore.calculateClusters(
          JSON.stringify(gameState),
        );
        const result: ClusterResult = JSON.parse(resultJson);

        if (result.clusters.length === 0) {
          return [];
        }

        // Store cluster info for use in removeClusters
        this._rustClusters = result;
        this._rustGameState = gameState;

        // Convert to Set<number>[] to match JS return type
        return result.clusters.map((cluster: number[]) => new Set(cluster));
      };

      // Store original
      proto._originalCalculateClusters = originalCalculateClusters;

      // Patch removeClusters to use Rust surrounded checks
      const originalRemoveClusters = proto.removeClusters;

      proto.removeClusters = function (this: any) {
        const clusters = this.calculateClusters();

        if (clusters.length === 0) {
          this.player.largestClusterBoundingBox = null;
          return;
        }

        // Find the largest cluster
        let largestIndex = 0;
        let largestSize = clusters[0].size;
        for (let i = 1; i < clusters.length; i++) {
          const size = clusters[i].size;
          if (size > largestSize) {
            largestSize = size;
            largestIndex = i;
          }
        }

        const largestCluster = clusters[largestIndex];
        if (largestCluster === undefined) throw new Error("No clusters");

        // Use Rust bounding box if available
        if (this._rustClusters?.largest_cluster_bbox) {
          const [minX, minY, maxX, maxY] =
            this._rustClusters.largest_cluster_bbox;
          this.player.largestClusterBoundingBox = { minX, minY, maxX, maxY };
        } else {
          // Fallback to JS calculation
          const mg = this.mg;
          const calculateBoundingBox = (
            _mg: any,
            tiles: Set<number>,
          ): { minX: number; minY: number; maxX: number; maxY: number } => {
            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const tile of tiles) {
              const x = tile % mg.width();
              const y = Math.floor(tile / mg.width());
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
            return { minX, minY, maxX, maxY };
          };
          this.player.largestClusterBoundingBox = calculateBoundingBox(
            mg,
            largestCluster,
          );
        }

        // Use Rust surrounded checks if we have state
        if (this._rustClusters && this._rustGameState) {
          const clustersJson = JSON.stringify(this._rustClusters.clusters);
          const resultJson = rustCore.checkSurroundedClusters(
            JSON.stringify(this._rustGameState),
            clustersJson,
            largestIndex,
          );
          const surroundedInfo: SurroundedClusterInfo[] =
            JSON.parse(resultJson);

          for (const info of surroundedInfo) {
            if (info.should_remove) {
              const cluster = clusters[info.cluster_index];
              if (info.cluster_index === largestIndex) {
                // For largest cluster, check if surrounded by enemy
                if (
                  info.surrounded_by !== null &&
                  info.surrounded_by !== undefined
                ) {
                  const enemy = this.mg.playerBySmallID(info.surrounded_by);
                  if (enemy && !enemy.isFriendly(this.player)) {
                    this.removeCluster(cluster);
                  }
                }
              } else {
                this.removeCluster(cluster);
              }
            }
          }
        } else {
          // Fallback to original JS implementation
          originalRemoveClusters.call(this);
        }
      };

      proto._originalRemoveClusters = originalRemoveClusters;
    },
  },
  {
    modulePath: "../src/core/execution/BotExecution",
    className: "BotExecution",
    method: "tick",
    patchFn: (rustCore, proto) => {
      const originalTick = proto.tick;

      proto.tick = function (this: any, ticks: number) {
        const mg = this.mg;
        const bot = this.bot;
        if (!mg || !bot) {
          originalTick.call(this, ticks);
          return;
        }

        // Get or create Rust BotExecution instance
        this._rustExec ??= new rustCore.BotExecution(bot.id());

        // Build game state for Rust
        const traitorNeighborIds: string[] = [];
        const enemyNeighborIds: string[] = [];

        for (const neighbor of bot.neighbors()) {
          if (!neighbor.isPlayer()) continue;
          if (bot.isFriendly(neighbor)) continue;
          enemyNeighborIds.push(neighbor.id());
          if (neighbor.isTraitor()) {
            traitorNeighborIds.push(neighbor.id());
          }
        }

        const gameState: BotGameState = {
          ticks,
          bot_alive: bot.isAlive(),
          bot_troops: bot.troops(),
          max_troops: mg.config().maxTroops(bot),
          shares_border_with_terra_nullius: bot.sharesBorderWith(
            mg.terraNullius(),
          ),
          traitor_neighbor_ids: traitorNeighborIds,
          enemy_neighbor_ids: enemyNeighborIds,
        };

        // Call Rust tick
        const resultJson = this._rustExec.tickJson(JSON.stringify(gameState));
        const result: BotTickResult = JSON.parse(resultJson);

        if (result.skip) {
          return;
        }

        if (result.deactivate) {
          this.active = false;
          return;
        }

        // Handle first tick - initialize attack behavior
        if (result.first_tick) {
          // Initialize attack behavior (uses JS AiAttackBehavior)
          if (!this.attackBehavior) {
            // Import AiAttackBehavior dynamically stored on proto
            if (this._AiAttackBehavior) {
              this.attackBehavior = new this._AiAttackBehavior(
                this.random,
                mg,
                bot,
                this._rustExec.triggerRatio,
                this._rustExec.reserveRatio,
                this._rustExec.expandRatio,
              );
            }
          }
          if (this.attackBehavior) {
            this.attackBehavior.sendAttack(mg.terraNullius());
          }
          return;
        }

        // Accept alliance requests (keep in JS as it's simple)
        for (const req of bot.incomingAllianceRequests()) {
          req.accept();
        }
        for (const alliance of bot.alliances()) {
          if (!alliance.onlyOneAgreedToExtend()) continue;
          const human = alliance.other(bot);
          if (this._AllianceExtensionExecution) {
            mg.addExecution(
              new this._AllianceExtensionExecution(bot, human.id()),
            );
          }
        }

        // Handle attack actions
        if (result.attack_target) {
          const target = mg.player(result.attack_target);
          if (target && this.attackBehavior) {
            // Check and break alliance before attacking if needed
            const alliance = bot.allianceWith(target);
            if (alliance !== null) {
              bot.breakAlliance(alliance);
            }
            this.attackBehavior.sendAttack(target);
          }
        } else if (result.attack_terra_nullius) {
          if (this.attackBehavior) {
            this.attackBehavior.sendAttack(mg.terraNullius());
          }
        } else if (result.attack_random) {
          if (this.attackBehavior) {
            this.attackBehavior.attackRandomTarget();
          }
        }
      };

      proto._originalTick = originalTick;
    },
  },
  {
    modulePath: "../src/core/execution/SpawnExecution",
    className: "SpawnExecution",
    method: "tick",
    patchFn: (rustCore, proto) => {
      const originalTick = proto.tick;

      proto.tick = function (this: any, ticks: number) {
        // Set inactive first (matches JS behavior)
        this.active = false;

        // Get game reference (set by init())
        const mg = this.mg;
        if (!mg) return;

        // Check if in spawn phase
        if (!mg.inSpawnPhase()) {
          return;
        }

        // Get or create player
        let player: any;
        if (mg.hasPlayer(this.playerInfo.id)) {
          player = mg.player(this.playerInfo.id);
        } else {
          player = mg.addPlayer(this.playerInfo);
        }

        // Get Rust SpawnExecution instance (create if needed)
        if (!this._rustExec) {
          const playerInfoJson = JSON.stringify({
            name: this.playerInfo.name,
            player_type: this.playerInfo.playerType,
            client_id: this.playerInfo.clientID,
            id: this.playerInfo.id,
            is_lobby_creator: this.playerInfo.isLobbyCreator ?? false,
          });
          this._rustExec = new rustCore.SpawnExecution(
            "game_id", // Match test usage
            playerInfoJson,
            this.tile,
          );
        }

        // Build game state for Rust
        const width = mg.width();
        const height = mg.height();
        const totalTiles = width * height;

        const landData: boolean[] = new Array(totalTiles);
        const ownerData: number[] = new Array(totalTiles);
        const borderData: boolean[] = new Array(totalTiles);

        for (let i = 0; i < totalTiles; i++) {
          landData[i] = mg.isLand(i);
          ownerData[i] = mg.hasOwner(i) ? mg.ownerID(i) : -1;
          borderData[i] = mg.isBorder(i);
        }

        const playerSpawnTiles = mg
          .allPlayers()
          .filter((p: any) => p.id() !== this.playerInfo.id)
          .map((p: any) => p.spawnTile() ?? null);

        const gameState: SpawnGameState = {
          width,
          height,
          in_spawn_phase: mg.inSpawnPhase(),
          land_data: landData,
          owner_data: ownerData,
          border_data: borderData,
          player_spawn_tiles: playerSpawnTiles,
          min_distance_between_players: mg.config().minDistanceBetweenPlayers(),
          num_spawn_phase_turns: mg.config().numSpawnPhaseTurns(),
          current_tick: mg.ticks(),
        };

        // Call Rust tick
        const resultJson = this._rustExec.tickJson(JSON.stringify(gameState));
        const action: SpawnAction | null = JSON.parse(resultJson);

        if (!action) {
          console.warn(`SpawnExecution: cannot spawn ${this.playerInfo.name}`);
          return;
        }

        // Apply actions to JS game state
        // Relinquish old tiles
        player.tiles().forEach((t: number) => player.relinquish(t));

        // Conquer new tiles
        action.tiles_to_conquer.forEach((t: number) => {
          player.conquer(t);
        });

        // Add executions if needed (use stored references from module import)
        if (!player.hasSpawned()) {
          // These will be set from the async import
          if (this._PlayerExecution && this._PlayerType) {
            mg.addExecution(new this._PlayerExecution(player));
            if (player.type() === this._PlayerType.Bot) {
              mg.addExecution(new this._BotExecution(player));
            }
          }
        }

        // Set spawn tile
        player.setSpawnTile(action.spawn_tile);

        // Update this.tile for consistency
        this.tile = action.spawn_tile;
      };

      // Store original for fallback
      proto._originalTick = originalTick;
    },
  },
  {
    modulePath: "../src/core/execution/NationExecution",
    className: "NationExecution",
    method: "tick",
    patchFn: (rustCore, proto) => {
      const originalTick = proto.tick;
      const originalInit = proto.init;

      // Patch init to create Rust instance with difficulty
      proto.init = function (this: any, mg: any) {
        originalInit.call(this, mg);

        // Create Rust NationExecution instance
        if (!this._rustExec) {
          this._rustExec = new rustCore.NationExecution(
            this.nation.playerInfo.id,
            this.gameID,
          );
          // Initialize with difficulty
          const difficulty = mg.config().gameConfig().difficulty;
          this._rustExec.initWithDifficulty(difficulty);
        }
      };

      proto.tick = function (this: any, ticks: number) {
        const mg = this.mg;
        if (!mg || !this._rustExec) {
          originalTick.call(this, ticks);
          return;
        }

        // Use Rust to check if we should act this tick (for warship tracking, always check)
        // Warship tracking happens every tick on non-Easy difficulty
        if (
          this.warshipBehavior !== null &&
          this.player !== null &&
          this.player.isAlive() &&
          mg.config().gameConfig().difficulty !== 0 // Difficulty.Easy
        ) {
          this.warshipBehavior.trackShipsAndRetaliate();
        }

        // Check if nation should act this tick using Rust
        if (!this._rustExec.shouldActThisTick(ticks)) {
          return;
        }

        if (this.player === null) {
          return;
        }

        // Handle spawn phase
        if (mg.inSpawnPhase()) {
          if (this.nation.spawnCell === undefined) {
            // Use SpawnExecution for random placement
            if (this._SpawnExecution) {
              mg.addExecution(
                new this._SpawnExecution(this.gameID, this.nation.playerInfo),
              );
            }
            return;
          }

          // Select a tile near the position defined in the map manifest
          const rl = this.randomSpawnLand();
          if (rl === null) {
            console.warn(`cannot spawn ${this.nation.playerInfo.name}`);
            return;
          }

          if (this._SpawnExecution) {
            mg.addExecution(
              new this._SpawnExecution(this.gameID, this.nation.playerInfo, rl),
            );
          }
          return;
        }

        if (!this.player.isAlive()) {
          this.active = false;
          this._rustExec.setActive(false);
          return;
        }

        // Initialize behaviors if needed (using Rust check)
        if (this._rustExec.needsBehaviorInit()) {
          if (this._NationEmojiBehavior) {
            this.emojiBehavior = new this._NationEmojiBehavior(
              this.random,
              mg,
              this.player,
            );
          }
          if (this._NationMIRVBehavior) {
            this.mirvBehavior = new this._NationMIRVBehavior(
              this.random,
              mg,
              this.player,
              this.emojiBehavior,
            );
          }
          if (this._NationAllianceBehavior) {
            this.allianceBehavior = new this._NationAllianceBehavior(
              this.random,
              mg,
              this.player,
              this.emojiBehavior,
            );
          }
          if (this._NationWarshipBehavior) {
            this.warshipBehavior = new this._NationWarshipBehavior(
              this.random,
              mg,
              this.player,
              this.emojiBehavior,
            );
          }
          if (this._AiAttackBehavior) {
            this.attackBehavior = new this._AiAttackBehavior(
              this.random,
              mg,
              this.player,
              this._rustExec.triggerRatio,
              this._rustExec.reserveRatio,
              this._rustExec.expandRatio,
              this.allianceBehavior,
              this.emojiBehavior,
            );
          }

          this._rustExec.markBehaviorsInitialized();

          // Send an attack on the first tick
          if (this.attackBehavior) {
            this.attackBehavior.forceSendAttack(mg.terraNullius());
          }
          return;
        }

        // Run the rest of tick logic (behaviors already initialized)
        if (this.emojiBehavior) {
          this.emojiBehavior.maybeSendCasualEmoji();
        }
        this.updateRelationsFromEmbargos();
        if (this.allianceBehavior) {
          this.allianceBehavior.handleAllianceRequests();
          this.allianceBehavior.handleAllianceExtensionRequests();
        }
        this.handleUnits();
        this.handleEmbargoesToHostileNations();
        if (this.mirvBehavior) {
          this.mirvBehavior.considerMIRV();
        }
        this.maybeAttack();
        if (this.warshipBehavior) {
          this.warshipBehavior.counterWarshipInfestation();
        }
      };

      proto._originalTick = originalTick;
      proto._originalInit = originalInit;
    },
  },
  {
    modulePath: "../src/core/execution/TransportShipExecution",
    className: "TransportShipExecution",
    method: "tick",
    patchFn: (rustCore, proto) => {
      const originalTick = proto.tick;
      const originalInit = proto.init;

      // Patch init to create Rust instance
      proto.init = function (this: any, mg: any, ticks: number) {
        originalInit.call(this, mg, ticks);

        // Create Rust TransportShipExecution instance after JS init
        if (this.active && !this._rustExec) {
          this._rustExec = new rustCore.TransportShipExecution(
            this.startTroops ?? 0,
          );
          this._rustExec.initTick(ticks);
        }
      };

      proto.tick = function (this: any, ticks: number) {
        // Fallback to original if no Rust instance
        if (!this._rustExec || this.dst === null) {
          originalTick.call(this, ticks);
          return;
        }

        if (!this.active) {
          return;
        }

        if (!this.boat.isActive()) {
          this.active = false;
          this._rustExec.setActive(false);
          return;
        }

        // Use Rust to check timing
        if (!this._rustExec.shouldMove(ticks)) {
          return;
        }
        this._rustExec.updateLastMove(ticks);

        // Update lastMove for JS compatibility
        this.lastMove = ticks;

        // Team mate ownership transfer (keep in JS - complex game logic)
        const boatOwner = this.boat.owner();
        if (
          this.originalOwner.isDisconnected() &&
          boatOwner !== this.originalOwner &&
          boatOwner.isOnSameTeam(this.originalOwner)
        ) {
          this.attacker = boatOwner;
          this.originalOwner = boatOwner;
        }

        // Handle retreat (keep pathfinding in JS)
        if (this.boat.retreating()) {
          if (this.mg.owner(this.src) !== this.attacker) {
            const newSrc = this.attacker.bestTransportShipSpawn(this.dst);
            if (newSrc === false) {
              this.src = null;
            } else {
              this.src = newSrc;
            }
          }

          if (this.src === null) {
            console.warn(
              "TransportShipExecution: retreating but no src found for new attacker",
            );
            this.attacker.addTroops(this.boat.troops());
            this.boat.delete(false);
            this.active = false;
            this._rustExec.setActive(false);
            return;
          } else {
            this.dst = this.src;
            if (this.boat.targetTile() !== this.dst) {
              this.boat.setTargetTile(this.dst);
            }
          }
        }

        // Pathfinding stays in JS
        const result = this.pathFinder.nextTile(this.boat.tile(), this.dst);
        const PathFindResultType = this._PathFindResultType;

        switch (result.type) {
          case PathFindResultType.Completed: {
            const dstOwnedByAttacker =
              this.mg.owner(this.dst) === this.attacker;

            if (dstOwnedByAttacker) {
              // Use Rust for retreat survivor calculation
              const survivors = this._rustExec.calculateRetreatSurvivors(
                this.boat.troops(),
              );
              const survivorCount = survivors[0];
              const deaths = survivors[1];

              this.attacker.addTroops(survivorCount);
              this.boat.delete(false);
              this.active = false;
              this._rustExec.setActive(false);

              // Record stats
              this.mg
                .stats()
                .boatArriveTroops(this.attacker, this.target, survivorCount);

              if (deaths > 0) {
                const renderTroops = this._renderTroops;
                if (renderTroops) {
                  this.mg.displayMessage(
                    `Attack cancelled, ${renderTroops(deaths)} soldiers killed during retreat.`,
                    this._MessageType.ATTACK_CANCELLED,
                    this.attacker.id(),
                  );
                }
              }
              return;
            }

            // Conquer destination
            this.attacker.conquer(this.dst);

            if (
              this.target.isPlayer() &&
              this.attacker.isFriendly(this.target)
            ) {
              // Friendly - just add troops
              this.attacker.addTroops(this.boat.troops());
            } else {
              // Enemy - start attack
              if (this._AttackExecution) {
                this.mg.addExecution(
                  new this._AttackExecution(
                    this.boat.troops(),
                    this.attacker,
                    this.targetID,
                    this.dst,
                    false,
                  ),
                );
              }
            }

            this.boat.delete(false);
            this.active = false;
            this._rustExec.setActive(false);

            // Record stats
            this.mg
              .stats()
              .boatArriveTroops(this.attacker, this.target, this.boat.troops());
            return;
          }
          case PathFindResultType.NextTile:
            this.boat.move(result.node);
            break;
          case PathFindResultType.Pending:
            break;
          case PathFindResultType.PathNotFound:
            this.attacker.addTroops(this.boat.troops());
            this.boat.delete(false);
            this.active = false;
            this._rustExec.setActive(false);
            return;
        }
      };

      proto._originalTick = originalTick;
      proto._originalInit = originalInit;
    },
  },
];

// Legacy sync replacements (kept for compatibility)
const RUST_REPLACEMENTS: Record<
  string,
  {
    target: () => any;
    method: string;
    rustFn: (rustCore: RustCore, original: AnyFn) => AnyFn;
  }
> = {};

beforeAll(async () => {
  if (process.env.USE_RUST_CORE === "0") {
    console.log("[TestSetup] Rust WASM disabled via USE_RUST_CORE=0");
    return;
  }

  try {
    const core = loadRustCore();
    globalThis.__RUST_WASM_AVAILABLE__ = true;
    globalThis.__RUST_CORE__ = core;

    let patchCount = 0;

    // Apply legacy sync replacements
    for (const [name, config] of Object.entries(RUST_REPLACEMENTS)) {
      try {
        const target = config.target();
        const original = target[config.method];
        if (typeof original === "function") {
          target[config.method] = config.rustFn(core, original);
          patchCount++;
          console.log(`[TestSetup] Patched ${name} -> Rust`);
        }
      } catch (e) {
        console.warn(`[TestSetup] Failed to patch ${name}:`, e);
      }
    }

    // Apply async patches using dynamic import
    for (const patch of ASYNC_PATCHES) {
      try {
        const module = await import(patch.modulePath);
        const proto = module[patch.className].prototype;

        if (proto && typeof proto[patch.method] === "function") {
          patch.patchFn(core, proto);
          patchCount++;
          console.log(
            `[TestSetup] Patched ${patch.className}.${patch.method} -> Rust`,
          );

          // Also import dependent modules for SpawnExecution
          if (patch.className === "SpawnExecution") {
            try {
              const playerExecMod = await import(
                "../src/core/execution/PlayerExecution"
              );
              const botExecMod = await import(
                "../src/core/execution/BotExecution"
              );
              const gameMod = await import("../src/core/game/Game");

              // Store on prototype for access in patched method
              proto._PlayerExecution = playerExecMod.PlayerExecution;
              proto._BotExecution = botExecMod.BotExecution;
              proto._PlayerType = gameMod.PlayerType;
            } catch (depErr) {
              console.warn(
                "[TestSetup] Failed to load SpawnExecution dependencies:",
                depErr,
              );
            }
          }

          // Also import dependent modules for BotExecution
          if (patch.className === "BotExecution") {
            try {
              const aiAttackMod = await import(
                "../src/core/execution/utils/AiAttackBehavior"
              );
              const allianceExtMod = await import(
                "../src/core/execution/alliance/AllianceExtensionExecution"
              );

              // Store on prototype for access in patched method
              proto._AiAttackBehavior = aiAttackMod.AiAttackBehavior;
              proto._AllianceExtensionExecution =
                allianceExtMod.AllianceExtensionExecution;
            } catch (depErr) {
              console.warn(
                "[TestSetup] Failed to load BotExecution dependencies:",
                depErr,
              );
            }
          }

          // Also import dependent modules for NationExecution
          if (patch.className === "NationExecution") {
            try {
              const spawnExecMod = await import(
                "../src/core/execution/SpawnExecution"
              );
              const emojiBehaviorMod = await import(
                "../src/core/execution/nation/NationEmojiBehavior"
              );
              const mirvBehaviorMod = await import(
                "../src/core/execution/nation/NationMIRVBehavior"
              );
              const allianceBehaviorMod = await import(
                "../src/core/execution/nation/NationAllianceBehavior"
              );
              const warshipBehaviorMod = await import(
                "../src/core/execution/nation/NationWarshipBehavior"
              );
              const aiAttackMod = await import(
                "../src/core/execution/utils/AiAttackBehavior"
              );

              // Store on prototype for access in patched method
              proto._SpawnExecution = spawnExecMod.SpawnExecution;
              proto._NationEmojiBehavior = emojiBehaviorMod.NationEmojiBehavior;
              proto._NationMIRVBehavior = mirvBehaviorMod.NationMIRVBehavior;
              proto._NationAllianceBehavior =
                allianceBehaviorMod.NationAllianceBehavior;
              proto._NationWarshipBehavior =
                warshipBehaviorMod.NationWarshipBehavior;
              proto._AiAttackBehavior = aiAttackMod.AiAttackBehavior;
            } catch (depErr) {
              console.warn(
                "[TestSetup] Failed to load NationExecution dependencies:",
                depErr,
              );
            }
          }

          // Also import dependent modules for TransportShipExecution
          if (patch.className === "TransportShipExecution") {
            try {
              const attackExecMod = await import(
                "../src/core/execution/AttackExecution"
              );
              const astarMod = await import("../src/core/pathfinding/AStar");
              const gameMod = await import("../src/core/game/Game");
              const utilsMod = await import("../src/client/Utils");

              // Store on prototype for access in patched method
              proto._AttackExecution = attackExecMod.AttackExecution;
              proto._PathFindResultType = astarMod.PathFindResultType;
              proto._MessageType = gameMod.MessageType;
              proto._renderTroops = utilsMod.renderTroops;
            } catch (depErr) {
              console.warn(
                "[TestSetup] Failed to load TransportShipExecution dependencies:",
                depErr,
              );
            }
          }
        }
      } catch (e) {
        console.warn(
          `[TestSetup] Failed to patch ${patch.className}.${patch.method}:`,
          e,
        );
      }
    }

    console.log(
      `[TestSetup] Rust WASM loaded, ${patchCount} functions patched`,
    );
  } catch {
    console.log("[TestSetup] Rust WASM not available, using pure JS");
  }
});

export function isRustAvailable(): boolean {
  return globalThis.__RUST_WASM_AVAILABLE__;
}

export function getRustCore(): RustCore | null {
  return globalThis.__RUST_CORE__;
}
