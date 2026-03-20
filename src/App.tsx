/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Bomb as BombIcon, Trophy, RefreshCw, Zap, Shield, Flame, HardHat, Mouse, Bug } from 'lucide-react';

// --- Constants ---
const GRID_SIZE = 13;
const CELL_SIZE = 40;
const BOMB_TIMER = 3000;
const EXPLOSION_DURATION = 500;
const TICK_RATE = 100;
const ENEMY_SPEED = 1000; // ms per move

enum CellType {
  Empty = 0,
  Wall = 1,
  Block = 2,
}

type Position = { x: number; y: number };

interface Player {
  id: 'blue' | 'red';
  pos: Position;
  bombs: number;
  maxBombs: number;
  range: number;
  isAlive: boolean;
  score: number;
}

interface Enemy {
  id: string;
  pos: Position;
  isAlive: boolean;
  lastMove: number;
}

interface Bomb {
  id: string;
  pos: Position;
  ownerId: 'blue' | 'red';
  timer: number;
  range: number;
}

interface Explosion {
  id: string;
  pos: Position;
  timer: number;
}

// --- Utilities ---
const isSamePos = (p1: Position, p2: Position) => 
  Math.round(p1.x) === Math.round(p2.x) && Math.round(p1.y) === Math.round(p2.y);

const generateGrid = () => {
  const grid: CellType[][] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    const row: CellType[] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      if (x === 0 || x === GRID_SIZE - 1 || y === 0 || y === GRID_SIZE - 1) {
        row.push(CellType.Wall);
      } else if (x % 2 === 0 && y % 2 === 0) {
        row.push(CellType.Wall);
      } else {
        const isStartArea = 
          (x <= 2 && y <= 2) || 
          (x >= GRID_SIZE - 3 && y >= GRID_SIZE - 3);
        
        // Reduced block density (0.2 instead of 0.3)
        if (!isStartArea && Math.random() > 0.2) {
          row.push(CellType.Block);
        } else {
          row.push(CellType.Empty);
        }
      }
    }
    grid.push(row);
  }
  return grid;
};

// --- Sound Synthesis ---
const playSound = (type: 'place' | 'explode' | 'death') => {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.connect(gain);
  gain.connect(ctx.destination);

  const now = ctx.currentTime;

  if (type === 'place') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.1);
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    osc.start(now);
    osc.stop(now + 0.1);
  } else if (type === 'explode') {
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(100, now);
    osc.frequency.exponentialRampToValueAtTime(20, now + 0.5);
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
    osc.start(now);
    osc.stop(now + 0.5);
  } else if (type === 'death') {
    osc.type = 'square';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.linearRampToValueAtTime(110, now + 0.3);
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.linearRampToValueAtTime(0.01, now + 0.3);
    osc.start(now);
    osc.stop(now + 0.3);
  }
};

export default function App() {
  const [grid, setGrid] = useState<CellType[][]>(generateGrid());
  const [players, setPlayers] = useState<Record<string, Player>>({
    blue: { id: 'blue', pos: { x: 1, y: 1 }, bombs: 0, maxBombs: 1, range: 2, isAlive: true, score: 0 },
    red: { id: 'red', pos: { x: GRID_SIZE - 2, y: GRID_SIZE - 2 }, bombs: 0, maxBombs: 1, range: 2, isAlive: true, score: 0 },
  });
  const [bombs, setBombs] = useState<Bomb[]>([]);
  const [explosions, setExplosions] = useState<Explosion[]>([]);
  const [enemies, setEnemies] = useState<Enemy[]>([]);
  const [gameState, setGameState] = useState<'playing' | 'gameover'>('playing');
  const [winner, setWinner] = useState<string | null>(null);
  const [localPlayerId, setLocalPlayerId] = useState<'blue' | 'red' | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const gameLoopRef = useRef<NodeJS.Timeout | null>(null);
  const gridRef = useRef(grid);
  const playersRef = useRef(players);
  const bombsRef = useRef(bombs);
  const explosionsRef = useRef(explosions);
  const enemiesRef = useRef(enemies);
  const gameStateRef = useRef(gameState);

  useEffect(() => { gridRef.current = grid; }, [grid]);
  useEffect(() => { playersRef.current = players; }, [players]);
  useEffect(() => { bombsRef.current = bombs; }, [bombs]);
  useEffect(() => { explosionsRef.current = explosions; }, [explosions]);
  useEffect(() => { enemiesRef.current = enemies; }, [enemies]);
  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);

  // --- WebSocket Setup ---
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}`);
    socketRef.current = socket;

    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'init') {
        setLocalPlayerId(msg.playerId);
      } else if (msg.type === 'move') {
        handleMove(msg.playerId, msg.dx, msg.dy, true);
      } else if (msg.type === 'bomb') {
        placeBomb(msg.playerId, true);
      } else if (msg.type === 'reset') {
        resetGame(true);
      }
    };

    return () => socket.close();
  }, []);

  // --- Game Logic ---

  const placeBomb = useCallback((playerId: 'blue' | 'red', isRemote = false) => {
    const currentPlayer = playersRef.current[playerId];
    if (!currentPlayer.isAlive || currentPlayer.bombs >= currentPlayer.maxBombs || gameStateRef.current !== 'playing') return;

    const pos = { x: Math.round(currentPlayer.pos.x), y: Math.round(currentPlayer.pos.y) };
    if (bombsRef.current.some(b => isSamePos(b.pos, pos))) return;

    if (!isRemote && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'bomb', playerId }));
    }

    playSound('place');

    const newBomb: Bomb = {
      id: Math.random().toString(36).substr(2, 9),
      pos,
      ownerId: playerId,
      timer: BOMB_TIMER,
      range: currentPlayer.range,
    };

    setBombs(current => {
      const next = [...current, newBomb];
      bombsRef.current = next;
      return next;
    });
    setPlayers(prev => {
      const next = {
        ...prev,
        [playerId]: { ...prev[playerId], bombs: prev[playerId].bombs + 1 }
      };
      playersRef.current = next;
      return next;
    });
  }, []);

  const handleExplosion = useCallback((bomb: Bomb, currentGrid: CellType[][], currentBombs: Bomb[]) => {
    const range = bomb.range;
    const affected: Position[] = [bomb.pos];
    const directions = [{ x: 0, y: 1 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: -1, y: 0 }];

    const nextGrid = [...currentGrid.map(row => [...row])];
    const explodedBombIds = new Set<string>([bomb.id]);
    const bombsToExplode = [bomb];

    // We use a queue to handle chain reactions properly
    let head = 0;
    while (head < bombsToExplode.length) {
      const b = bombsToExplode[head++];
      const bRange = b.range;

      directions.forEach(dir => {
        for (let i = 1; i <= bRange; i++) {
          const p = { x: b.pos.x + dir.x * i, y: b.pos.y + dir.y * i };
          if (p.x < 0 || p.x >= GRID_SIZE || p.y < 0 || p.y >= GRID_SIZE) break;
          
          const cell = nextGrid[p.y][p.x];
          if (cell === CellType.Wall) break;

          affected.push(p);

          if (cell === CellType.Block) {
            nextGrid[p.y][p.x] = CellType.Empty;
            break; 
          }

          // Chain reaction
          const otherBomb = currentBombs.find(ob => isSamePos(ob.pos, p) && !explodedBombIds.has(ob.id));
          if (otherBomb) {
            explodedBombIds.add(otherBomb.id);
            bombsToExplode.push(otherBomb);
          }
        }
      });
    }

    return { nextGrid, affected, explodedBombIds };
  }, []);

  const handleMove = useCallback((playerId: 'blue' | 'red', dx: number, dy: number, isRemote = false) => {
    if (!isRemote && playerId !== localPlayerId) return false;

    let success = false;
    setPlayers(prev => {
      const player = prev[playerId];
      if (!player.isAlive || gameStateRef.current !== 'playing') return prev;

      const nextX = Math.round(player.pos.x + dx);
      const nextY = Math.round(player.pos.y + dy);

      if (
        nextX >= 0 && nextX < GRID_SIZE &&
        nextY >= 0 && nextY < GRID_SIZE &&
        gridRef.current[nextY][nextX] === CellType.Empty &&
        !bombsRef.current.some(b => isSamePos(b.pos, { x: nextX, y: nextY }))
      ) {
        success = true;
        if (!isRemote && socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({ type: 'move', playerId, dx, dy }));
        }
        const nextPlayers = {
          ...prev,
          [playerId]: { ...player, pos: { x: nextX, y: nextY } }
        };
        playersRef.current = nextPlayers;
        return nextPlayers;
      }
      return prev;
    });
    return success;
  }, [localPlayerId]);

  const resetGame = useCallback((isRemote = false) => {
    const newGrid = generateGrid();
    const newPlayers: Record<string, Player> = {
      blue: { id: 'blue', pos: { x: 1, y: 1 }, bombs: 0, maxBombs: 1, range: 2, isAlive: true, score: 0 },
      red: { id: 'red', pos: { x: GRID_SIZE - 2, y: GRID_SIZE - 2 }, bombs: 0, maxBombs: 1, range: 2, isAlive: true, score: 0 },
    };

    // Spawn 3 scrap-bots in random empty locations
    const newEnemies: Enemy[] = [];
    while (newEnemies.length < 3) {
      const x = Math.floor(Math.random() * (GRID_SIZE - 2)) + 1;
      const y = Math.floor(Math.random() * (GRID_SIZE - 2)) + 1;
      const isStartArea = (x <= 2 && y <= 2) || (x >= GRID_SIZE - 3 && y >= GRID_SIZE - 3);
      if (newGrid[y][x] === CellType.Empty && !isStartArea && !newEnemies.some(e => isSamePos(e.pos, { x, y }))) {
        newEnemies.push({ id: Math.random().toString(36).substr(2, 9), pos: { x, y }, isAlive: true, lastMove: Date.now() });
      }
    }

    if (!isRemote && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'reset' }));
    }

    gameStateRef.current = 'gameover';
    gridRef.current = newGrid;
    playersRef.current = newPlayers;
    bombsRef.current = [];
    explosionsRef.current = [];
    enemiesRef.current = newEnemies;

    setGrid(newGrid);
    setPlayers(newPlayers);
    setBombs([]);
    setExplosions([]);
    setEnemies(newEnemies);
    setWinner(null);
    
    setTimeout(() => {
      setGameState('playing');
      gameStateRef.current = 'playing';
    }, 0);
  }, []);

  // --- Effects ---

  useEffect(() => {
    resetGame(true); // Initial reset to spawn enemies
  }, [resetGame]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (gameState !== 'playing' || !localPlayerId) return;
      switch (e.key.toLowerCase()) {
        case 'w': handleMove(localPlayerId, 0, -1); break;
        case 's': handleMove(localPlayerId, 0, 1); break;
        case 'a': handleMove(localPlayerId, -1, 0); break;
        case 'd': handleMove(localPlayerId, 1, 0); break;
        case ' ': placeBomb(localPlayerId); break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [gameState, placeBomb, localPlayerId, handleMove]);

  useEffect(() => {
    gameLoopRef.current = setInterval(() => {
      if (gameStateRef.current !== 'playing') return;

      const currentGrid = gridRef.current;
      const currentPlayers = playersRef.current;
      const currentBombs = [...bombsRef.current];
      const currentExplosions = [...explosionsRef.current];
      const currentEnemies = [...enemiesRef.current];

      // 1. Update Bombs and Explosions
      const nextBombs = currentBombs.map(b => ({ ...b, timer: b.timer - TICK_RATE }));
      const nextExplosions = currentExplosions
        .map(e => ({ ...e, timer: e.timer - TICK_RATE }))
        .filter(e => e.timer > 0);
      
      const exploding = nextBombs.filter(b => b.timer <= 0);
      
      let finalGrid = [...currentGrid.map(row => [...row])];
      let newExplosions: Explosion[] = [];
      const allExplodedIds = new Set<string>();

      if (exploding.length > 0) {
        playSound('explode');
        exploding.forEach(bomb => {
          if (allExplodedIds.has(bomb.id)) return;
          const { nextGrid, affected, explodedBombIds } = handleExplosion(bomb, finalGrid, nextBombs);
          finalGrid = nextGrid;
          explodedBombIds.forEach(id => allExplodedIds.add(id));
          affected.forEach(p => {
            // Only add if not already in nextExplosions or newExplosions
            const alreadyExists = [...nextExplosions, ...newExplosions].some(e => isSamePos(e.pos, p));
            if (!alreadyExists) {
              newExplosions.push({ id: Math.random().toString(36).substr(2, 9), pos: p, timer: EXPLOSION_DURATION });
            }
          });
        });
      }

      const activeExplosions = [...nextExplosions, ...newExplosions];

      // 2. Update Enemies
      const now = Date.now();
      const nextEnemies = currentEnemies.map(enemy => {
        if (!enemy.isAlive) return enemy;

        // Check if hit by explosion
        if (activeExplosions.some(e => isSamePos(e.pos, enemy.pos))) {
          return { ...enemy, isAlive: false };
        }

        // Move enemy
        if (now - enemy.lastMove > ENEMY_SPEED) {
          const directions = [{ x: 0, y: 1 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: -1, y: 0 }];
          const validMoves = directions.filter(dir => {
            const next = { x: enemy.pos.x + dir.x, y: enemy.pos.y + dir.y };
            return (
              next.x >= 0 && next.x < GRID_SIZE &&
              next.y >= 0 && next.y < GRID_SIZE &&
              currentGrid[next.y][next.x] === CellType.Empty &&
              !currentBombs.some(b => isSamePos(b.pos, next))
            );
          });

          if (validMoves.length > 0) {
            const move = validMoves[Math.floor(Math.random() * validMoves.length)];
            return {
              ...enemy,
              pos: { x: enemy.pos.x + move.x, y: enemy.pos.y + move.y },
              lastMove: now
            };
          }
        }
        return enemy;
      }).filter(e => e.isAlive);

      // 3. Atomic State Updates
      if (exploding.length > 0) {
        setGrid(() => {
          if (gameStateRef.current !== 'playing') return gridRef.current;
          gridRef.current = finalGrid;
          return finalGrid;
        });
      }

      setExplosions(() => {
        if (gameStateRef.current !== 'playing') return explosionsRef.current;
        explosionsRef.current = activeExplosions;
        return activeExplosions;
      });

      setEnemies(() => {
        if (gameStateRef.current !== 'playing') return enemiesRef.current;
        enemiesRef.current = nextEnemies;
        return nextEnemies;
      });

      setBombs(prev => {
        if (gameStateRef.current !== 'playing') return [];
        const next = prev
          .map(b => {
            const updated = nextBombs.find(nb => nb.id === b.id);
            return updated ? updated : b;
          })
          .filter(b => !allExplodedIds.has(b.id) && b.timer > 0);
        bombsRef.current = next;
        return next;
      });

      setPlayers(prev => {
        if (gameStateRef.current !== 'playing') return prev;
        const next = { ...prev };
        let changed = false;

        if (allExplodedIds.size > 0) {
          const bombCounts: Record<string, number> = { blue: 0, red: 0 };
          currentBombs.forEach(b => {
            if (allExplodedIds.has(b.id)) {
              bombCounts[b.ownerId]++;
            }
          });
          if (bombCounts.blue > 0 || bombCounts.red > 0) {
            next.blue = { ...next.blue, bombs: Math.max(0, next.blue.bombs - bombCounts.blue) };
            next.red = { ...next.red, bombs: Math.max(0, next.red.bombs - bombCounts.red) };
            changed = true;
          }
        }

        ['blue', 'red'].forEach(id => {
          const pId = id as 'blue' | 'red';
          const p = next[pId];
          if (p.isAlive) {
            // Hit by explosion
            if (activeExplosions.some(e => isSamePos(e.pos, p.pos))) {
              p.isAlive = false;
              changed = true;
              playSound('death');
            }
            // Hit by enemy
            if (nextEnemies.some(e => isSamePos(e.pos, p.pos))) {
              p.isAlive = false;
              changed = true;
              playSound('death');
            }
          }
        });

        if (changed) playersRef.current = next;
        return changed ? next : prev;
      });
    }, TICK_RATE);

    return () => {
      if (gameLoopRef.current) clearInterval(gameLoopRef.current);
    };
  }, [handleExplosion, localPlayerId, handleMove]);

  useEffect(() => {
    if (!players.blue.isAlive && !players.red.isAlive) {
      setGameState('gameover');
      setWinner('Draw');
    } else if (!players.blue.isAlive) {
      setGameState('gameover');
      setWinner('Red Player');
    } else if (!players.red.isAlive) {
      setGameState('gameover');
      setWinner('Blue Player');
    }
  }, [players]);

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0] p-4 md:p-8 flex flex-col items-center">
      {/* Header */}
      <header className="w-full max-w-4xl flex justify-between items-end border-b-2 border-[#141414] pb-4 mb-8">
        <div>
          <h1 className="text-4xl font-black italic tracking-tighter uppercase leading-none">Shrewd Saboteurs</h1>
          <p className="text-xs font-mono opacity-60 mt-1 uppercase tracking-widest">v1.1.0 // Engineer Shrew Edition</p>
        </div>
        <div className="flex gap-8 text-right">
          {!localPlayerId ? (
            <div className="flex items-center gap-2 text-orange-600 animate-pulse font-bold uppercase text-xs">
              <RefreshCw size={14} className="animate-spin" /> Connecting to Server...
            </div>
          ) : (
            <>
              <div>
                <span className="block text-[10px] font-mono opacity-50 uppercase">Player Blue</span>
                <span className={`text-xl font-bold ${!players.blue.isAlive ? 'line-through opacity-30' : 'text-blue-600'}`}>
                  {players.blue.isAlive ? 'ACTIVE' : 'ELIMINATED'}
                </span>
              </div>
              <div>
                <span className="block text-[10px] font-mono opacity-50 uppercase">Player Red</span>
                <span className={`text-xl font-bold ${!players.red.isAlive ? 'line-through opacity-30' : 'text-red-600'}`}>
                  {players.red.isAlive ? 'ACTIVE' : 'ELIMINATED'}
                </span>
              </div>
            </>
          )}
        </div>
      </header>

      {/* Game Area */}
      <main className="relative flex flex-col items-center gap-8">
        <div 
          className="relative bg-[#141414] p-1 border-4 border-[#141414] shadow-[8px_8px_0px_0px_rgba(20,20,20,0.1)]"
          style={{ width: GRID_SIZE * CELL_SIZE + 8, height: GRID_SIZE * CELL_SIZE + 8 }}
        >
          {/* Grid Rendering */}
          <div className="grid" style={{ gridTemplateColumns: `repeat(${GRID_SIZE}, ${CELL_SIZE}px)` }}>
            {grid.map((row, y) => row.map((cell, x) => (
              <div 
                key={`${x}-${y}`} 
                className="relative"
                style={{ width: CELL_SIZE, height: CELL_SIZE }}
              >
                {cell === CellType.Wall && (
                  <div className="w-full h-full bg-[#2a2a2a] border border-[#141414] flex items-center justify-center relative overflow-hidden">
                    <div className="absolute top-1 left-1 w-1 h-1 bg-white/10 rounded-full" />
                    <div className="absolute top-1 right-1 w-1 h-1 bg-white/10 rounded-full" />
                    <div className="absolute bottom-1 left-1 w-1 h-1 bg-white/10 rounded-full" />
                    <div className="absolute bottom-1 right-1 w-1 h-1 bg-white/10 rounded-full" />
                    <Shield size={16} className="text-white/5" />
                  </div>
                )}
                {cell === CellType.Block && (
                  <motion.div 
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="w-full h-full bg-[#5d4037] border-2 border-[#141414] flex items-center justify-center relative shadow-inner"
                  >
                    <div className="absolute inset-1 border border-white/10" />
                    <div className="w-full h-full flex items-center justify-center opacity-20">
                      <div className="w-[2px] h-full bg-black/40 rotate-45 absolute" />
                      <div className="w-[2px] h-full bg-black/40 -rotate-45 absolute" />
                    </div>
                  </motion.div>
                )}
                {cell === CellType.Empty && (
                  <div className="w-full h-full border-[0.5px] border-white/5" />
                )}
              </div>
            )))}
          </div>

          {/* Bombs */}
          <AnimatePresence mode="popLayout">
            {bombs.map(bomb => (
              <motion.div
                key={bomb.id}
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0 }}
                className="absolute z-10 flex items-center justify-center"
                style={{ 
                  left: bomb.pos.x * CELL_SIZE + 4, 
                  top: bomb.pos.y * CELL_SIZE + 4,
                  width: CELL_SIZE,
                  height: CELL_SIZE
                }}
              >
                <motion.div
                  animate={{ scale: [1, 1.15, 1] }}
                  transition={{ repeat: Infinity, duration: 0.6, ease: "easeInOut" }}
                >
                  <BombIcon size={24} className={bomb.ownerId === 'blue' ? 'text-blue-400' : 'text-red-400'} fill="currentColor" />
                </motion.div>
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Explosions */}
          <AnimatePresence>
            {explosions.map(exp => (
              <motion.div
                key={exp.id}
                initial={{ scale: 0, opacity: 1 }}
                animate={{ scale: 1.2, opacity: [1, 0] }}
                exit={{ opacity: 0 }}
                className="absolute z-20 bg-orange-500 border-2 border-yellow-300"
                style={{ 
                  left: exp.pos.x * CELL_SIZE + 4, 
                  top: exp.pos.y * CELL_SIZE + 4,
                  width: CELL_SIZE,
                  height: CELL_SIZE
                }}
              />
            ))}
          </AnimatePresence>

          {/* Enemies (Scrap-Bots) */}
          <AnimatePresence>
            {enemies.map(enemy => (
              <motion.div
                key={enemy.id}
                initial={{ scale: 0 }}
                animate={{ x: enemy.pos.x * CELL_SIZE, y: enemy.pos.y * CELL_SIZE, scale: 1 }}
                exit={{ scale: 0, rotate: 180 }}
                className="absolute z-25 flex items-center justify-center bg-zinc-900 border-2 border-zinc-700 rounded-lg shadow-lg overflow-hidden"
                style={{ 
                  left: 4, 
                  top: 4,
                  width: CELL_SIZE - 8,
                  height: CELL_SIZE - 8
                }}
              >
                <img 
                  src={`https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${enemy.id}&backgroundColor=transparent`}
                  alt="Scrap Bot"
                  className="w-full h-full p-1"
                  referrerPolicy="no-referrer"
                />
                <div className="absolute top-1 right-1 w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Players (Engineer Shrews) */}
          {(Object.values(players) as Player[]).map(player => player.isAlive && (
            <motion.div
              key={player.id}
              animate={{ x: player.pos.x * CELL_SIZE, y: player.pos.y * CELL_SIZE }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className={`absolute z-30 flex items-center justify-center border-2 border-[#141414] shadow-xl rounded-xl overflow-visible`}
              style={{ 
                left: 4, 
                top: 4,
                width: CELL_SIZE - 8,
                height: CELL_SIZE - 8,
                backgroundColor: player.id === 'blue' ? '#3B82F6' : '#EF4444',
                opacity: (localPlayerId && player.id !== localPlayerId) ? 0.8 : 1
              }}
            >
              <div className="relative w-full h-full flex items-center justify-center">
                <img 
                  src={`https://api.dicebear.com/9.x/pixel-art/svg?seed=${player.id === 'blue' ? 'shrew-b' : 'shrew-r'}&backgroundColor=transparent`}
                  alt="Engineer Shrew"
                  className="w-full h-full scale-125"
                  referrerPolicy="no-referrer"
                />
                <div className="absolute -top-2 -right-2 bg-yellow-400 p-0.5 rounded-full border border-black shadow-sm z-40">
                  <HardHat size={12} className="text-black" />
                </div>
                {player.id === localPlayerId && (
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-white text-[8px] font-bold px-1.5 py-0.5 rounded-full border-2 border-black whitespace-nowrap shadow-md z-50">
                    YOU
                  </div>
                )}
              </div>
            </motion.div>
          ))}

          {/* Game Over Overlay */}
          <AnimatePresence>
            {gameState === 'gameover' && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="absolute inset-0 z-50 bg-[#141414]/90 flex flex-col items-center justify-center p-8 text-center"
              >
                <Trophy size={64} className="text-yellow-400 mb-4" />
                <h2 className="text-4xl font-black text-white uppercase italic tracking-tighter mb-2">Game Over</h2>
                <p className="text-xl text-white/80 font-mono mb-8">Winner: {winner}</p>
                <button 
                  onClick={resetGame}
                  className="group flex items-center gap-2 bg-[#E4E3E0] text-[#141414] px-8 py-4 font-bold uppercase tracking-widest hover:bg-white transition-colors"
                >
                  <RefreshCw size={20} className="group-hover:rotate-180 transition-transform duration-500" />
                  Play Again
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Controls Info */}
        <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white/50 p-4 border border-[#141414]/10 rounded-lg">
            <h3 className="text-[10px] font-mono uppercase opacity-50 mb-2">Movement</h3>
            <div className="flex gap-2">
              {['W', 'A', 'S', 'D'].map(k => (
                <kbd key={k} className="px-2 py-1 bg-[#141414] text-white rounded font-bold text-xs">{k}</kbd>
              ))}
            </div>
          </div>
          <div className="bg-white/50 p-4 border border-[#141414]/10 rounded-lg">
            <h3 className="text-[10px] font-mono uppercase opacity-50 mb-2">Action</h3>
            <kbd className="px-4 py-1 bg-[#141414] text-white rounded font-bold text-xs">SPACEBAR</kbd>
            <span className="ml-2 text-xs opacity-60 italic">Place Bomb</span>
          </div>
          <div className="bg-white/50 p-4 border border-[#141414]/10 rounded-lg flex items-center gap-4">
            <div className="flex items-center gap-1 text-blue-600 font-bold">
              <Zap size={16} /> {players.blue.maxBombs}
            </div>
            <div className="flex items-center gap-1 text-orange-600 font-bold">
              <Flame size={16} /> {players.blue.range}
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-12 text-[10px] font-mono opacity-40 uppercase tracking-[0.2em]">
        Shrewd Saboteurs // Experimental Build // {new Date().getFullYear()}
      </footer>
    </div>
  );
}
