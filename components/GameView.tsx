import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Gamepad2, Trophy, Zap, Star, ChevronRight, RotateCcw,
  Lightbulb, CheckCircle2, XCircle, ArrowRight, Sparkles,
  Target, Brain, Filter, ArrowUpDown, BarChart3, Play,
  Volume2, VolumeX, Clock, X, Search, BookOpen, ArrowLeft, Wheat
} from 'lucide-react';
import { StoryMode } from './game/StoryMode';
import { FarmScene, FARM } from './game/FarmScenes';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

type GAFSLane = 'G' | 'A' | 'F' | 'S';
type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';
type GamePhase = 'landing' | 'start' | 'playing' | 'feedback' | 'level-complete' | 'game-complete';

interface AnswerChip {
  id: string;
  label: string;
  correctLane: GAFSLane;
  isDistractor?: boolean;
}

interface Level {
  id: number;
  difficulty: Difficulty;
  industry: string;
  industryEmoji: string;
  question: string;
  chips: AnswerChip[];
  explanation: {
    G: string;
    A: string;
    F: string;
    S: string;
  };
}

interface LaneState {
  G: string | null;
  A: string | null;
  F: string | null;
  S: string | null;
}

// ═══════════════════════════════════════════════════════════════════
// LEVEL DATA
// ═══════════════════════════════════════════════════════════════════

const LEVELS: Level[] = [
  {
    id: 1, difficulty: 'easy', industry: 'Retail', industryEmoji: '🛒',
    question: 'Show me total sales by product.',
    chips: [
      { id: 'l1-g', label: 'Product Name', correctLane: 'G' },
      { id: 'l1-a', label: 'SUM(Sales)', correctLane: 'A' },
      { id: 'l1-f', label: 'No filter needed', correctLane: 'F' },
      { id: 'l1-s', label: 'No specific order', correctLane: 'S' },
      { id: 'l1-d1', label: 'Customer Name', correctLane: 'G', isDistractor: true },
      { id: 'l1-d2', label: 'COUNT(Orders)', correctLane: 'A', isDistractor: true },
    ],
    explanation: {
      G: 'We group by Product Name because we want to compare products.',
      A: 'SUM(Sales) gives us the total sales per product.',
      F: 'No filter — we want all available data.',
      S: 'No specific sort order was requested.',
    }
  },
  {
    id: 2, difficulty: 'easy', industry: 'Retail', industryEmoji: '🛒',
    question: 'Show me the top 5 products by total sales in 2023.',
    chips: [
      { id: 'l2-g', label: 'Product Name', correctLane: 'G' },
      { id: 'l2-a', label: 'SUM(Sales)', correctLane: 'A' },
      { id: 'l2-f', label: 'Year = 2023', correctLane: 'F' },
      { id: 'l2-s', label: 'Highest → Lowest, Top 5', correctLane: 'S' },
      { id: 'l2-d1', label: 'AVG(Profit)', correctLane: 'A', isDistractor: true },
      { id: 'l2-d2', label: 'Customer Region', correctLane: 'G', isDistractor: true },
      { id: 'l2-d3', label: 'Ascending order', correctLane: 'S', isDistractor: true },
    ],
    explanation: {
      G: '"Products" tells us to group by Product Name.',
      A: '"Total sales" means SUM(Sales) — not average or count.',
      F: '"In 2023" restricts data to Year = 2023.',
      S: '"Top 5" means sort Highest → Lowest and limit to 5.',
    }
  },
  {
    id: 3, difficulty: 'easy', industry: 'Healthcare', industryEmoji: '🏥',
    question: 'Which departments had the highest average waiting time?',
    chips: [
      { id: 'l3-g', label: 'Department', correctLane: 'G' },
      { id: 'l3-a', label: 'AVG(Waiting Time)', correctLane: 'A' },
      { id: 'l3-f', label: 'No filter needed', correctLane: 'F' },
      { id: 'l3-s', label: 'Highest → Lowest', correctLane: 'S' },
      { id: 'l3-d1', label: 'Patient Name', correctLane: 'G', isDistractor: true },
      { id: 'l3-d2', label: 'SUM(Waiting Time)', correctLane: 'A', isDistractor: true },
    ],
    explanation: {
      G: '"Departments" is what we\'re comparing.',
      A: '"Average waiting time" = AVG(Waiting Time), not SUM.',
      F: 'No time or category restriction mentioned.',
      S: '"Highest" = sort descending.',
    }
  },
  {
    id: 4, difficulty: 'medium', industry: 'Finance', industryEmoji: '💰',
    question: 'Which client segments generated the most revenue this fiscal year?',
    chips: [
      { id: 'l4-g', label: 'Client Segment', correctLane: 'G' },
      { id: 'l4-a', label: 'SUM(Revenue)', correctLane: 'A' },
      { id: 'l4-f', label: 'This fiscal year', correctLane: 'F' },
      { id: 'l4-s', label: 'Highest → Lowest', correctLane: 'S' },
      { id: 'l4-d1', label: 'Account Manager', correctLane: 'G', isDistractor: true },
      { id: 'l4-d2', label: 'Last quarter', correctLane: 'F', isDistractor: true },
      { id: 'l4-d3', label: 'COUNT(Clients)', correctLane: 'A', isDistractor: true },
    ],
    explanation: {
      G: '"Client segments" is the dimension we compare.',
      A: '"Most revenue" = SUM(Revenue).',
      F: '"This fiscal year" restricts the time window.',
      S: '"Most" implies highest first.',
    }
  },
  {
    id: 5, difficulty: 'medium', industry: 'Logistics', industryEmoji: '🚛',
    question: 'Which warehouses had the most delayed shipments in Q3?',
    chips: [
      { id: 'l5-g', label: 'Warehouse', correctLane: 'G' },
      { id: 'l5-a', label: 'COUNT(Shipments)', correctLane: 'A' },
      { id: 'l5-f', label: 'Q3 + Status = Delayed', correctLane: 'F' },
      { id: 'l5-s', label: 'Highest → Lowest', correctLane: 'S' },
      { id: 'l5-d1', label: 'Driver Name', correctLane: 'G', isDistractor: true },
      { id: 'l5-d2', label: 'SUM(Weight)', correctLane: 'A', isDistractor: true },
      { id: 'l5-d3', label: 'This year', correctLane: 'F', isDistractor: true },
    ],
    explanation: {
      G: '"Warehouses" is what we compare.',
      A: '"Most delayed shipments" = COUNT(Shipments), not sum.',
      F: 'Two filters: Q3 (time) + Status = Delayed (dimension).',
      S: '"Most" = descending.',
    }
  },
  {
    id: 6, difficulty: 'medium', industry: 'Marketing', industryEmoji: '📣',
    question: 'Which campaigns had the highest conversion rate this quarter?',
    chips: [
      { id: 'l6-g', label: 'Campaign', correctLane: 'G' },
      { id: 'l6-a', label: 'Conversion Rate (ratio)', correctLane: 'A' },
      { id: 'l6-f', label: 'This quarter', correctLane: 'F' },
      { id: 'l6-s', label: 'Highest → Lowest', correctLane: 'S' },
      { id: 'l6-d1', label: 'Ad Platform', correctLane: 'G', isDistractor: true },
      { id: 'l6-d2', label: 'SUM(Impressions)', correctLane: 'A', isDistractor: true },
    ],
    explanation: {
      G: '"Campaigns" is the grouping dimension.',
      A: '"Conversion rate" is a calculated ratio — not a simple SUM or COUNT.',
      F: '"This quarter" limits the time range.',
      S: '"Highest" = sort descending.',
    }
  },
  {
    id: 7, difficulty: 'hard', industry: 'Retail', industryEmoji: '🛒',
    question: 'Compare monthly sales this year vs last year by region.',
    chips: [
      { id: 'l7-g', label: 'Region + Month', correctLane: 'G' },
      { id: 'l7-a', label: 'SUM(Sales)', correctLane: 'A' },
      { id: 'l7-f', label: 'This year + Previous year', correctLane: 'F' },
      { id: 'l7-s', label: 'Chronological (Oldest → Newest)', correctLane: 'S' },
      { id: 'l7-d1', label: 'Product Category', correctLane: 'G', isDistractor: true },
      { id: 'l7-d2', label: 'AVG(Sales)', correctLane: 'A', isDistractor: true },
      { id: 'l7-d3', label: 'Highest → Lowest', correctLane: 'S', isDistractor: true },
    ],
    explanation: {
      G: '"By region" + "monthly" = two grouping dimensions (Region + Month).',
      A: '"Sales" = SUM(Sales).',
      F: '"This year vs last year" = comparison across two years.',
      S: 'Time comparisons are best shown chronologically.',
    }
  },
  {
    id: 8, difficulty: 'hard', industry: 'Human Resources', industryEmoji: '👥',
    question: 'Show average salary by department for employees hired after 2020, highest first.',
    chips: [
      { id: 'l8-g', label: 'Department', correctLane: 'G' },
      { id: 'l8-a', label: 'AVG(Salary)', correctLane: 'A' },
      { id: 'l8-f', label: 'Hire Date > 2020', correctLane: 'F' },
      { id: 'l8-s', label: 'Highest → Lowest', correctLane: 'S' },
      { id: 'l8-d1', label: 'Employee Name', correctLane: 'G', isDistractor: true },
      { id: 'l8-d2', label: 'SUM(Salary)', correctLane: 'A', isDistractor: true },
      { id: 'l8-d3', label: 'All employees', correctLane: 'F', isDistractor: true },
    ],
    explanation: {
      G: '"By department" = group by Department.',
      A: '"Average salary" = AVG(Salary), not SUM.',
      F: '"Hired after 2020" = date filter on Hire Date.',
      S: '"Highest first" = sort descending explicitly stated.',
    }
  },
  {
    id: 9, difficulty: 'expert', industry: 'E-commerce', industryEmoji: '🛍️',
    question: 'Top 3 products by total revenue in each category for Q1 2024.',
    chips: [
      { id: 'l9-g', label: 'Category + Product', correctLane: 'G' },
      { id: 'l9-a', label: 'SUM(Revenue)', correctLane: 'A' },
      { id: 'l9-f', label: 'Q1 2024', correctLane: 'F' },
      { id: 'l9-s', label: 'Top 3 per category, Highest first', correctLane: 'S' },
      { id: 'l9-d1', label: 'Customer Country', correctLane: 'G', isDistractor: true },
      { id: 'l9-d2', label: 'AVG(Revenue)', correctLane: 'A', isDistractor: true },
      { id: 'l9-d3', label: 'Year = 2024', correctLane: 'F', isDistractor: true },
      { id: 'l9-d4', label: 'Top 3 overall', correctLane: 'S', isDistractor: true },
    ],
    explanation: {
      G: '"In each category" + "products" = nested grouping (Category + Product).',
      A: '"Total revenue" = SUM(Revenue).',
      F: '"Q1 2024" — specific quarter, not just year.',
      S: '"Top 3 per category" = partitioned ranking, not overall top 3.',
    }
  },
  {
    id: 10, difficulty: 'expert', industry: 'Manufacturing', industryEmoji: '🏭',
    question: 'Which production lines had the lowest defect rate last month, excluding maintenance shutdowns?',
    chips: [
      { id: 'l10-g', label: 'Production Line', correctLane: 'G' },
      { id: 'l10-a', label: 'Defect Rate (ratio)', correctLane: 'A' },
      { id: 'l10-f', label: 'Last month + Exclude maintenance', correctLane: 'F' },
      { id: 'l10-s', label: 'Lowest → Highest', correctLane: 'S' },
      { id: 'l10-d1', label: 'Factory Location', correctLane: 'G', isDistractor: true },
      { id: 'l10-d2', label: 'COUNT(Defects)', correctLane: 'A', isDistractor: true },
      { id: 'l10-d3', label: 'Highest → Lowest', correctLane: 'S', isDistractor: true },
    ],
    explanation: {
      G: '"Production lines" is what we compare.',
      A: '"Defect rate" is a ratio — not a raw count.',
      F: 'Two filters: "last month" (time) + "excluding maintenance" (dimension filter).',
      S: '"Lowest" = ascending sort — the opposite of most questions!',
    }
  },
];

// ═══════════════════════════════════════════════════════════════════
// LANE CONFIG
// ═══════════════════════════════════════════════════════════════════

const LANE_CONFIG: Record<GAFSLane, { label: string; fullLabel: string; icon: React.ReactNode; color: string; bg: string; border: string; ring: string; chipBg: string; question: string }> = {
  G: { label: 'G', fullLabel: 'Grouping', icon: <Target className="w-4 h-4" />, color: 'text-indigo-400', bg: 'bg-indigo-500/10', border: 'border-indigo-500/30', ring: 'ring-indigo-500/40', chipBg: 'bg-indigo-500/20 text-indigo-200 border-indigo-500/40', question: 'What am I comparing?' },
  A: { label: 'A', fullLabel: 'Aggregating', icon: <BarChart3 className="w-4 h-4" />, color: 'text-cyan-400', bg: 'bg-cyan-500/10', border: 'border-cyan-500/30', ring: 'ring-cyan-500/40', chipBg: 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40', question: 'What am I measuring?' },
  F: { label: 'F', fullLabel: 'Filtering', icon: <Filter className="w-4 h-4" />, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', ring: 'ring-emerald-500/40', chipBg: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40', question: 'Which data matters?' },
  S: { label: 'S', fullLabel: 'Sorting', icon: <ArrowUpDown className="w-4 h-4" />, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30', ring: 'ring-amber-500/40', chipBg: 'bg-amber-500/20 text-amber-200 border-amber-500/40', question: 'How to present results?' },
};

const DIFFICULTY_COLORS: Record<Difficulty, { bg: string; text: string; label: string }> = {
  easy: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', label: 'Easy' },
  medium: { bg: 'bg-amber-500/15', text: 'text-amber-400', label: 'Medium' },
  hard: { bg: 'bg-orange-500/15', text: 'text-orange-400', label: 'Hard' },
  expert: { bg: 'bg-red-500/15', text: 'text-red-400', label: 'Expert' },
};

// ═══════════════════════════════════════════════════════════════════
// CONFETTI PARTICLE
// ═══════════════════════════════════════════════════════════════════

const ConfettiParticle = ({ delay }: { delay: number }) => {
  const colors = ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const x = Math.random() * 100;
  const size = 4 + Math.random() * 8;
  return (
    <motion.div
      className="absolute rounded-full"
      style={{ left: `${x}%`, top: '-10px', width: size, height: size, backgroundColor: color }}
      initial={{ y: 0, opacity: 1, rotate: 0 }}
      animate={{ y: 600, opacity: 0, rotate: 720 + Math.random() * 360, x: (Math.random() - 0.5) * 200 }}
      transition={{ duration: 1.5 + Math.random(), delay, ease: 'easeOut' }}
    />
  );
};

// ═══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════

interface GameViewProps {
  onNavigateToBuilder?: () => void;
  onExit?: () => void;
}

const PracticeGame: React.FC<GameViewProps> = ({ onNavigateToBuilder, onExit }) => {
  // Game state
  const [gamePhase, setGamePhase] = useState<GamePhase>('landing');
  const [currentLevel, setCurrentLevel] = useState(0);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [perfectLevels, setPerfectLevels] = useState(0);
  const [levelStartTime, setLevelStartTime] = useState(0);
  const [totalTime, setTotalTime] = useState(0);
  const [showConfetti, setShowConfetti] = useState(false);

  // Level state
  const [lanes, setLanes] = useState<LaneState>({ G: null, A: null, F: null, S: null });
  const [mistakes, setMistakes] = useState(0);
  const [feedback, setFeedback] = useState<Record<GAFSLane, 'correct' | 'wrong' | null>>({ G: null, A: null, F: null, S: null });
  const [selectedChip, setSelectedChip] = useState<string | null>(null);
  const [dragOverLane, setDragOverLane] = useState<GAFSLane | null>(null);
  const [revealedHints, setRevealedHints] = useState<Set<GAFSLane>>(new Set());
  const [levelScore, setLevelScore] = useState(0);

  // Timer
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const level = LEVELS[currentLevel];

  // Shuffled chips for current level
  const shuffledChips = useMemo(() => {
    if (!level) return [];
    const chips = [...level.chips];
    for (let i = chips.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [chips[i], chips[j]] = [chips[j], chips[i]];
    }
    return chips;
  }, [currentLevel]);

  // Get the correct (non-distractor) chips for the current level
  const correctChips = useMemo(() => {
    if (!level) return [];
    return level.chips.filter(c => !c.isDistractor);
  }, [currentLevel]);

  // Timer effect
  useEffect(() => {
    if (gamePhase === 'playing') {
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [gamePhase]);

  // Get available chips (not placed in any lane)
  const availableChips = useMemo(() => {
    const placedIds = new Set(Object.values(lanes).filter(Boolean));
    return shuffledChips.filter(c => !placedIds.has(c.id));
  }, [shuffledChips, lanes]);

  // ─── Actions ─────────────────────────────────────────────────────

  const startGame = useCallback(() => {
    setGamePhase('playing');
    setCurrentLevel(0);
    setScore(0);
    setStreak(0);
    setBestStreak(0);
    setHintsUsed(0);
    setPerfectLevels(0);
    setTotalTime(0);
    resetLevel();
    setLevelStartTime(Date.now());
  }, []);

  const resetLevel = useCallback(() => {
    setLanes({ G: null, A: null, F: null, S: null });
    setMistakes(0);
    setFeedback({ G: null, A: null, F: null, S: null });
    setSelectedChip(null);
    setDragOverLane(null);
    setRevealedHints(new Set());
    setLevelScore(0);
    setElapsed(0);
  }, []);

  const placeChip = useCallback((chipId: string, lane: GAFSLane) => {
    setLanes(prev => {
      // If lane already occupied, swap back
      const newLanes = { ...prev };
      // If chip is already in another lane, remove it
      for (const key of Object.keys(newLanes) as GAFSLane[]) {
        if (newLanes[key] === chipId) newLanes[key] = null;
      }
      newLanes[lane] = chipId;
      return newLanes;
    });
    setSelectedChip(null);
    setDragOverLane(null);
  }, []);

  const removeFromLane = useCallback((lane: GAFSLane) => {
    setLanes(prev => ({ ...prev, [lane]: null }));
  }, []);

  const useHint = useCallback(() => {
    if (!level) return;
    // Find first unplaced correct answer
    const laneOrder: GAFSLane[] = ['G', 'A', 'F', 'S'];
    for (const lane of laneOrder) {
      if (!lanes[lane] && !revealedHints.has(lane)) {
        const correct = correctChips.find(c => c.correctLane === lane);
        if (correct) {
          setRevealedHints(prev => new Set([...prev, lane]));
          setScore(s => Math.max(0, s - 50));
          setHintsUsed(h => h + 1);
          // Auto-place the hint
          placeChip(correct.id, lane);
          break;
        }
      }
    }
  }, [level, lanes, revealedHints, correctChips, placeChip]);

  const checkAnswer = useCallback(() => {
    if (!level) return;
    const newFeedback: Record<GAFSLane, 'correct' | 'wrong' | null> = { G: null, A: null, F: null, S: null };
    let allCorrect = true;
    let correctCount = 0;
    let wrongCount = 0;

    for (const lane of ['G', 'A', 'F', 'S'] as GAFSLane[]) {
      const placedChipId = lanes[lane];
      if (!placedChipId) {
        newFeedback[lane] = 'wrong';
        allCorrect = false;
        wrongCount++;
        continue;
      }
      const chip = level.chips.find(c => c.id === placedChipId);
      if (chip && !chip.isDistractor && chip.correctLane === lane) {
        newFeedback[lane] = 'correct';
        correctCount++;
      } else {
        newFeedback[lane] = 'wrong';
        allCorrect = false;
        wrongCount++;
      }
    }

    setFeedback(newFeedback);
    setMistakes(wrongCount);

    // Calculate score
    let points = correctCount * 100;
    points -= wrongCount * 25;
    const timeTaken = elapsed;
    if (timeTaken < 15 && allCorrect) points += 50; // Speed bonus
    if (allCorrect) {
      points += 200; // Perfect level bonus
      const newStreak = streak + 1;
      setStreak(newStreak);
      if (newStreak > bestStreak) setBestStreak(newStreak);
      if (newStreak >= 5) points = Math.round(points * 2);
      else if (newStreak >= 3) points = Math.round(points * 1.5);
      setPerfectLevels(p => p + 1);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 2000);
    } else {
      setStreak(0);
    }

    setLevelScore(Math.max(0, points));
    setScore(s => s + Math.max(0, points));
    setTotalTime(t => t + timeTaken);

    setGamePhase('feedback');

    // Auto-advance after showing feedback
    setTimeout(() => {
      setGamePhase('level-complete');
    }, 1800);
  }, [level, lanes, elapsed, streak, bestStreak]);

  const nextLevel = useCallback(() => {
    if (currentLevel + 1 >= LEVELS.length) {
      setGamePhase('game-complete');
    } else {
      setCurrentLevel(c => c + 1);
      resetLevel();
      setLevelStartTime(Date.now());
      setGamePhase('playing');
    }
  }, [currentLevel, resetLevel]);

  const restartGame = useCallback(() => {
    setGamePhase('start');
    setCurrentLevel(0);
    setScore(0);
    setStreak(0);
    setBestStreak(0);
    setHintsUsed(0);
    setPerfectLevels(0);
    setTotalTime(0);
    resetLevel();
  }, [resetLevel]);

  const exitGame = useCallback(() => {
    if (onExit) {
      onExit();
    } else {
      setGamePhase('landing');
      resetLevel();
      setCurrentLevel(0);
      setScore(0);
      setStreak(0);
      setBestStreak(0);
      setHintsUsed(0);
      setPerfectLevels(0);
      setTotalTime(0);
    }
  }, [onExit, resetLevel]);

  // Drag handlers
  const handleDragStart = (e: React.DragEvent, chipId: string) => {
    e.dataTransfer.setData('chipId', chipId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, lane: GAFSLane) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverLane(lane);
  };

  const handleDragLeave = () => setDragOverLane(null);

  const handleDrop = (e: React.DragEvent, lane: GAFSLane) => {
    e.preventDefault();
    const chipId = e.dataTransfer.getData('chipId');
    if (chipId) placeChip(chipId, lane);
    setDragOverLane(null);
  };

  // Click-to-place handler
  const handleChipClick = (chipId: string) => {
    if (selectedChip === chipId) {
      setSelectedChip(null);
    } else {
      setSelectedChip(chipId);
    }
  };

  const handleLaneClick = (lane: GAFSLane) => {
    if (selectedChip) {
      placeChip(selectedChip, lane);
    } else if (lanes[lane]) {
      // If lane has a chip and nothing is selected, remove it
      removeFromLane(lane);
    }
  };

  const allLanesFilled = lanes.G && lanes.A && lanes.F && lanes.S;

  // Star rating
  const getStarRating = () => {
    const maxScore = LEVELS.length * 600; // theoretical max per level
    const pct = score / maxScore;
    if (pct >= 0.8) return 3;
    if (pct >= 0.5) return 2;
    return 1;
  };

  // ═══════════════════════════════════════════════════════════════════
  // RENDER: LANDING PAGE (Educational Overlay)
  // ═══════════════════════════════════════════════════════════════════

  if (gamePhase === 'landing') {
    return (
      <div className="h-full overflow-auto bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950">
        <div className="max-w-3xl mx-auto px-6 py-10">
          {/* Header with close */}
          <div className="flex items-center justify-between mb-10">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600">
                <BookOpen className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-black text-white tracking-tight">What is GAFS?</h1>
                <p className="text-xs text-slate-500">The thinking framework behind every great analysis</p>
              </div>
            </div>
            {onExit && (
              <button onClick={onExit} className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors">
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* The Problem */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-6 mb-6">
              <h2 className="text-lg font-bold text-white mb-3">Why do beginners struggle with data analytics?</h2>
              <p className="text-sm text-slate-400 leading-relaxed mb-4">
                When a manager asks <span className="text-white font-semibold">"Show me the top 5 products by total sales in 2023"</span>, 
                beginners immediately reach for SQL syntax. Experienced analysts do something different — they first 
                <span className="text-indigo-400 font-semibold"> think about the analytical structure</span> of the question.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-red-500/5 border border-red-500/15 rounded-xl p-4">
                  <p className="text-xs font-bold text-red-400 mb-2">❌ Beginner thinks:</p>
                  <ul className="text-xs text-slate-400 space-y-1">
                    <li>• Do I need GROUP BY?</li>
                    <li>• Should I use SUM()?</li>
                    <li>• Where does ORDER BY go?</li>
                  </ul>
                </div>
                <div className="bg-emerald-500/5 border border-emerald-500/15 rounded-xl p-4">
                  <p className="text-xs font-bold text-emerald-400 mb-2">✅ Expert thinks:</p>
                  <ul className="text-xs text-slate-400 space-y-1">
                    <li>• What am I comparing?</li>
                    <li>• What am I measuring?</li>
                    <li>• Which data matters?</li>
                  </ul>
                </div>
              </div>
            </div>
          </motion.div>

          {/* GAFS Framework */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-6 mb-6">
              <h2 className="text-lg font-bold text-white mb-2">The GAFS Framework</h2>
              <p className="text-sm text-slate-400 mb-5">
                GAFS is a simple thinking framework that helps you decompose any business question into 
                <span className="text-white font-semibold"> four analytical decisions</span> — before touching any tool.
              </p>

              <div className="space-y-3">
                {(['G', 'A', 'F', 'S'] as GAFSLane[]).map((lane, i) => {
                  const config = LANE_CONFIG[lane];
                  const descriptions: Record<GAFSLane, { detail: string; example: string }> = {
                    G: { detail: 'Organise records into meaningful categories. This determines the dimension of your analysis.', example: '"by product" → Group by Product Name' },
                    A: { detail: 'Summarise values within each group using SUM, AVG, COUNT, MAX, or MIN.', example: '"total sales" → SUM(Sales)' },
                    F: { detail: 'Narrow the dataset to only the records relevant to the question.', example: '"in 2023" → Year = 2023' },
                    S: { detail: 'Arrange results so the answer is immediately clear and actionable.', example: '"top 5" → Highest → Lowest, Limit 5' },
                  };
                  const desc = descriptions[lane];
                  return (
                    <motion.div
                      key={lane}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.3 + i * 0.08 }}
                      className={`${config.bg} ${config.border} border rounded-xl p-4 flex gap-4`}
                    >
                      <div className="shrink-0 flex flex-col items-center gap-1 w-12">
                        <span className={`font-black text-2xl ${config.color}`}>{config.label}</span>
                        <span className={config.color}>{config.icon}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-sm font-bold text-white">{config.fullLabel}</p>
                          <span className="text-xs text-slate-500">— {config.question}</span>
                        </div>
                        <p className="text-xs text-slate-400 mb-1.5">{desc.detail}</p>
                        <p className="text-xs font-mono bg-black/20 px-2.5 py-1 rounded-md text-slate-300 inline-block">{desc.example}</p>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          </motion.div>

          {/* How GAFS maps to Question Builder */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
            <div className="bg-gradient-to-br from-indigo-500/10 to-purple-500/10 border border-indigo-500/20 rounded-2xl p-6 mb-6">
              <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
                <Search className="w-5 h-5 text-indigo-400" />
                How GAFS Maps to Your Question Builder
              </h2>
              <p className="text-sm text-slate-400 mb-4">
                The Question Builder in this app is designed around exactly these four concepts. 
                Once you understand GAFS, the builder becomes intuitive:
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  { gafs: 'G — Grouping', builder: '"by" Dimension dropdown', desc: 'Select what to compare', color: 'text-indigo-400', bg: 'bg-indigo-500/10 border-indigo-500/20' },
                  { gafs: 'A — Aggregation', builder: 'Metric + Aggregation selector', desc: 'Choose what to measure', color: 'text-cyan-400', bg: 'bg-cyan-500/10 border-cyan-500/20' },
                  { gafs: 'F — Filtering', builder: '"where" filters + time range', desc: 'Narrow the scope', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
                  { gafs: 'S — Sorting', builder: 'Sort order + Limit (Top N)', desc: 'Rank the results', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
                ].map(m => (
                  <div key={m.gafs} className={`${m.bg} border rounded-lg p-3`}>
                    <p className={`text-xs font-bold ${m.color} mb-0.5`}>{m.gafs}</p>
                    <p className="text-xs text-white font-semibold">→ {m.builder}</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">{m.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>

          {/* How the Game Works */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}>
            <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-6 mb-8">
              <h2 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
                <Gamepad2 className="w-5 h-5 text-purple-400" />
                How the Game Works
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[
                  { step: '1', title: 'Read the Question', desc: 'A business question appears in plain English — just like a real manager would ask.', icon: '📝' },
                  { step: '2', title: 'Drag & Drop', desc: 'Place the correct answer chips into the G, A, F, S lanes. Watch out for distractors!', icon: '🎯' },
                  { step: '3', title: 'Learn & Level Up', desc: 'See detailed explanations of why each answer is correct. Earn points and streak bonuses.', icon: '🏆' },
                ].map(s => (
                  <div key={s.step} className="text-center">
                    <div className="text-3xl mb-2">{s.icon}</div>
                    <p className="text-sm font-bold text-white mb-1">{s.title}</p>
                    <p className="text-xs text-slate-400">{s.desc}</p>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-center gap-6 mt-5 text-xs text-slate-500">
                <span className="flex items-center gap-1.5"><Target className="w-3.5 h-3.5" /> 10 Levels</span>
                <span className="flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> 6 Industries</span>
                <span className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5" /> Speed Bonuses</span>
                <span className="flex items-center gap-1.5"><Star className="w-3.5 h-3.5" /> Star Ratings</span>
              </div>
            </div>
          </motion.div>

          {/* Start Button */}
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setGamePhase('start')}
            className="w-full py-4 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-bold text-lg shadow-xl shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-shadow flex items-center justify-center gap-3"
          >
            <Play className="w-5 h-5" />
            Start the GAFS Challenge
          </motion.button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // RENDER: START SCREEN (Quick restart / level select)
  // ═══════════════════════════════════════════════════════════════════

  if (gamePhase === 'start') {
    return (
      <div className="h-full overflow-auto bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 flex items-center justify-center p-6">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-2xl w-full"
        >
          {/* Hero */}
          <div className="text-center mb-10">
            <motion.div
              animate={{ rotate: [0, -5, 5, 0] }}
              transition={{ repeat: Infinity, duration: 3, ease: 'easeInOut' }}
              className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-2xl shadow-indigo-500/30 mb-6"
            >
              <Gamepad2 className="w-10 h-10 text-white" />
            </motion.div>
            <h1 className="text-4xl font-black text-white mb-3 tracking-tight">
              GAFS Challenge
            </h1>
            <p className="text-lg text-slate-400 max-w-md mx-auto">
              Master analytical thinking through play. Decompose business questions into Grouping, Aggregating, Filtering & Sorting.
            </p>
          </div>

          {/* GAFS Quick Reference */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-8">
            {(['G', 'A', 'F', 'S'] as GAFSLane[]).map((lane, i) => {
              const config = LANE_CONFIG[lane];
              return (
                <motion.div
                  key={lane}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 + i * 0.08 }}
                  className={`${config.bg} ${config.border} border rounded-xl p-3 text-center`}
                >
                  <span className={`font-black text-xl ${config.color}`}>{config.label}</span>
                  <p className="text-xs font-semibold text-white mt-0.5">{config.fullLabel}</p>
                </motion.div>
              );
            })}
          </div>

          {/* Stats */}
          <div className="flex items-center justify-center gap-6 mb-8 text-sm text-slate-500">
            <span className="flex items-center gap-1.5"><Target className="w-4 h-4" /> 10 Levels</span>
            <span className="flex items-center gap-1.5"><Sparkles className="w-4 h-4" /> 6 Industries</span>
            <span className="flex items-center gap-1.5"><Zap className="w-4 h-4" /> Speed Bonuses</span>
          </div>

          {/* Buttons */}
          <div className="space-y-3">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              onClick={startGame}
              className="w-full py-4 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-bold text-lg shadow-xl shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-shadow flex items-center justify-center gap-3"
            >
              <Play className="w-5 h-5" />
              Start Challenge
            </motion.button>
            <div className="flex gap-3">
              <button
                onClick={() => setGamePhase('landing')}
                className="flex-1 py-3 rounded-xl bg-white/5 border border-white/10 text-slate-400 font-semibold text-sm hover:bg-white/10 transition-colors flex items-center justify-center gap-2"
              >
                <BookOpen className="w-4 h-4" />
                What is GAFS?
              </button>
              {onNavigateToBuilder && (
                <button
                  onClick={onNavigateToBuilder}
                  className="flex-1 py-3 rounded-xl bg-white/5 border border-white/10 text-slate-400 font-semibold text-sm hover:bg-white/10 transition-colors flex items-center justify-center gap-2"
                >
                  <Search className="w-4 h-4" />
                  Go to Question Builder
                </button>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // RENDER: GAME COMPLETE
  // ═══════════════════════════════════════════════════════════════════

  if (gamePhase === 'game-complete') {
    const stars = getStarRating();
    return (
      <div className="h-full overflow-auto bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 flex items-center justify-center p-6 relative">
        {showConfetti && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {Array.from({ length: 40 }).map((_, i) => <ConfettiParticle key={i} delay={i * 0.05} />)}
          </div>
        )}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-lg w-full"
        >
          <div className="text-center mb-8">
            <motion.div
              animate={{ rotate: [0, 360] }}
              transition={{ duration: 1, ease: 'easeOut' }}
              className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 shadow-2xl shadow-amber-500/30 mb-6"
            >
              <Trophy className="w-10 h-10 text-white" />
            </motion.div>
            <h1 className="text-3xl font-black text-white mb-2">Challenge Complete!</h1>
            <div className="flex items-center justify-center gap-1 mb-4">
              {[1, 2, 3].map(s => (
                <motion.div key={s} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.3 + s * 0.2 }}>
                  <Star className={`w-8 h-8 ${s <= stars ? 'text-amber-400 fill-amber-400' : 'text-slate-600'}`} />
                </motion.div>
              ))}
            </div>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-3 mb-8">
            {[
              { label: 'Total Score', value: score.toLocaleString(), icon: <Zap className="w-4 h-4 text-amber-400" /> },
              { label: 'Perfect Levels', value: `${perfectLevels}/10`, icon: <CheckCircle2 className="w-4 h-4 text-emerald-400" /> },
              { label: 'Best Streak', value: bestStreak.toString(), icon: <Sparkles className="w-4 h-4 text-purple-400" /> },
              { label: 'Total Time', value: `${Math.floor(totalTime / 60)}m ${totalTime % 60}s`, icon: <Clock className="w-4 h-4 text-cyan-400" /> },
            ].map((stat, i) => (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 + i * 0.1 }}
                className="bg-white/5 border border-white/10 rounded-xl p-4 text-center"
              >
                <div className="flex items-center justify-center gap-1.5 mb-1">{stat.icon}<span className="text-xs text-slate-400">{stat.label}</span></div>
                <p className="text-2xl font-black text-white">{stat.value}</p>
              </motion.div>
            ))}
          </div>

          {/* GAFS → Builder Mapping */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
            className="bg-gradient-to-br from-indigo-500/10 to-purple-500/10 border border-indigo-500/20 rounded-xl p-5 mb-6"
          >
            <h3 className="text-sm font-bold text-indigo-300 mb-3 flex items-center gap-2">
              <Brain className="w-4 h-4" />
              GAFS → Question Builder Mapping
            </h3>
            <div className="space-y-2">
              {[
                { gafs: 'G — Grouping', builder: '"by" Dimension selector', color: 'text-indigo-400' },
                { gafs: 'A — Aggregation', builder: 'Metric + Aggregation selector', color: 'text-cyan-400' },
                { gafs: 'F — Filtering', builder: '"where" filters + time range', color: 'text-emerald-400' },
                { gafs: 'S — Sorting', builder: 'Sort order + Limit (Top N)', color: 'text-amber-400' },
              ].map(m => (
                <div key={m.gafs} className="flex items-center gap-3 text-sm">
                  <span className={`font-bold ${m.color} w-36`}>{m.gafs}</span>
                  <ArrowRight className="w-3 h-3 text-slate-500 shrink-0" />
                  <span className="text-slate-300">{m.builder}</span>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <button
              onClick={restartGame}
              className="flex-1 py-3 rounded-xl bg-white/5 border border-white/10 text-slate-300 font-semibold hover:bg-white/10 transition-colors flex items-center justify-center gap-2"
            >
              <RotateCcw className="w-4 h-4" /> Play Again
            </button>
            {onNavigateToBuilder && (
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={onNavigateToBuilder}
                className="flex-1 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-bold shadow-lg shadow-indigo-500/25 flex items-center justify-center gap-2"
              >
                <Sparkles className="w-4 h-4" /> Try Question Builder
              </motion.button>
            )}
          </div>
        </motion.div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // RENDER: PLAYING + FEEDBACK + LEVEL COMPLETE
  // ═══════════════════════════════════════════════════════════════════

  const isFeedbackPhase = gamePhase === 'feedback' || gamePhase === 'level-complete';
  const diff = DIFFICULTY_COLORS[level.difficulty];

  return (
    <div className="h-full flex flex-col bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 relative overflow-hidden">
      {/* Confetti */}
      {showConfetti && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none z-50">
          {Array.from({ length: 30 }).map((_, i) => <ConfettiParticle key={i} delay={i * 0.04} />)}
        </div>
      )}

      {/* ── Top Bar ── */}
      <div className="shrink-0 px-6 py-3 flex items-center justify-between border-b border-white/5">
        <div className="flex items-center gap-4">
          <button
            onClick={exitGame}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors text-sm"
            title="Exit game"
          >
            <X className="w-4 h-4" />
            <span className="font-bold">Exit</span>
          </button>
          <div className="h-4 w-px bg-white/10" />
          <div className="flex items-center gap-2">
            <Gamepad2 className="w-4 h-4 text-indigo-400" />
            <span className="font-bold text-white text-sm">GAFS Challenge</span>
          </div>
          <span className={`${diff.bg} ${diff.text} text-xs font-bold px-2.5 py-1 rounded-full`}>
            {diff.label}
          </span>
          <span className="text-xs text-slate-500">
            {level.industryEmoji} {level.industry}
          </span>
        </div>

        <div className="flex items-center gap-5">
          {/* Timer */}
          <div className="flex items-center gap-1.5 text-slate-400 text-sm">
            <Clock className="w-3.5 h-3.5" />
            <span className="font-mono tabular-nums">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
          </div>
          {/* Streak */}
          {streak > 0 && (
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className="flex items-center gap-1 text-amber-400 text-sm font-bold"
            >
              <Zap className="w-3.5 h-3.5" />
              {streak}× streak
              {streak >= 5 && <span className="text-[10px] bg-amber-500/20 px-1.5 py-0.5 rounded-full">×2</span>}
              {streak >= 3 && streak < 5 && <span className="text-[10px] bg-amber-500/20 px-1.5 py-0.5 rounded-full">×1.5</span>}
            </motion.div>
          )}
          {/* Score */}
          <div className="flex items-center gap-1.5">
            <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
            <span className="font-black text-white text-lg tabular-nums">{score.toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* ── Progress Bar ── */}
      <div className="shrink-0 px-6 pt-3">
        <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
          <span>Level {currentLevel + 1} of {LEVELS.length}</span>
          <span>{Math.round(((currentLevel + (isFeedbackPhase ? 1 : 0)) / LEVELS.length) * 100)}%</span>
        </div>
        <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full"
            initial={{ width: '0%' }}
            animate={{ width: `${((currentLevel + (isFeedbackPhase ? 1 : 0)) / LEVELS.length) * 100}%` }}
            transition={{ duration: 0.5 }}
          />
        </div>
      </div>

      {/* ── Main Content ── */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-3xl mx-auto space-y-5">

          {/* Question Card */}
          <motion.div
            key={currentLevel}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-2xl p-6"
          >
            <p className="text-xs font-semibold text-indigo-400 mb-2 uppercase tracking-wider">Business Question</p>
            <p className="text-xl font-bold text-white leading-relaxed">"{level.question}"</p>
          </motion.div>

          {/* GAFS Lanes */}
          <div className="space-y-3">
            {(['G', 'A', 'F', 'S'] as GAFSLane[]).map((lane) => {
              const config = LANE_CONFIG[lane];
              const placedChipId = lanes[lane];
              const placedChip = placedChipId ? level.chips.find(c => c.id === placedChipId) : null;
              const fb = feedback[lane];
              const isOver = dragOverLane === lane;
              const isHinted = revealedHints.has(lane);

              return (
                <motion.div
                  key={lane}
                  layout
                  onClick={() => handleLaneClick(lane)}
                  onDragOver={(e) => handleDragOver(e, lane)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, lane)}
                  className={`flex items-center gap-4 px-5 py-3.5 rounded-xl border transition-all cursor-pointer
                    ${fb === 'correct' ? 'bg-emerald-500/15 border-emerald-500/40' : ''}
                    ${fb === 'wrong' ? 'bg-red-500/10 border-red-500/40' : ''}
                    ${!fb && isOver ? `${config.bg} ${config.border} ring-2 ${config.ring}` : ''}
                    ${!fb && !isOver ? `${config.bg} ${config.border} hover:ring-1 ${config.ring}` : ''}
                    ${selectedChip && !fb ? 'ring-1 ring-white/20' : ''}
                  `}
                >
                  {/* Lane label */}
                  <div className={`flex items-center gap-2 w-36 shrink-0 ${config.color}`}>
                    <span className="font-black text-lg">{config.label}</span>
                    {config.icon}
                    <span className="text-sm font-semibold">{config.fullLabel}</span>
                  </div>

                  {/* Drop zone / placed chip */}
                  <div className="flex-1 min-h-[36px] flex items-center">
                    {placedChip ? (
                      <motion.div
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold border ${config.chipBg} ${isHinted ? 'ring-1 ring-amber-400/50' : ''}`}
                      >
                        {placedChip.label}
                        {isHinted && <Lightbulb className="w-3 h-3 inline ml-1.5 text-amber-400" />}
                      </motion.div>
                    ) : (
                      <span className="text-sm text-slate-600 italic">
                        {selectedChip ? 'Click to place here' : 'Drag or click a chip, then click here'}
                      </span>
                    )}
                  </div>

                  {/* Feedback icon */}
                  <AnimatePresence>
                    {fb === 'correct' && (
                      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}>
                        <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                      </motion.div>
                    )}
                    {fb === 'wrong' && (
                      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}>
                        <XCircle className="w-5 h-5 text-red-400" />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>

          {/* Answer Chips Pool */}
          {!isFeedbackPhase && (
            <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
              <p className="text-xs text-slate-500 mb-3 font-semibold uppercase tracking-wider">Answer Chips — drag or click to place</p>
              <div className="flex flex-wrap gap-2">
                {availableChips.map(chip => (
                  <motion.div
                    key={chip.id}
                    layout
                    draggable
                    onDragStart={(e: any) => handleDragStart(e, chip.id)}
                    onClick={() => handleChipClick(chip.id)}
                    whileHover={{ scale: 1.05, y: -2 }}
                    whileTap={{ scale: 0.95 }}
                    className={`px-4 py-2.5 rounded-lg text-sm font-semibold cursor-grab active:cursor-grabbing border transition-all select-none
                      ${selectedChip === chip.id
                        ? 'bg-indigo-500/25 border-indigo-400 text-indigo-200 ring-2 ring-indigo-500/50 shadow-lg shadow-indigo-500/20'
                        : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:border-white/20'
                      }`}
                  >
                    {chip.label}
                  </motion.div>
                ))}
                {availableChips.length === 0 && (
                  <p className="text-sm text-slate-600 italic">All chips placed! Click "Check Answer" to verify.</p>
                )}
              </div>
            </div>
          )}

          {/* Explanations (shown after feedback) */}
          <AnimatePresence>
            {gamePhase === 'level-complete' && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="bg-white/[0.03] border border-white/10 rounded-xl p-5 space-y-3"
              >
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">💡 Why?</p>
                {(['G', 'A', 'F', 'S'] as GAFSLane[]).map(lane => {
                  const config = LANE_CONFIG[lane];
                  const correct = correctChips.find(c => c.correctLane === lane);
                  return (
                    <div key={lane} className="flex gap-3 text-sm">
                      <span className={`font-black ${config.color} w-5 shrink-0`}>{lane}</span>
                      <div>
                        <span className="text-white font-semibold">{correct?.label}</span>
                        <span className="text-slate-400 ml-2">— {level.explanation[lane]}</span>
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Action Buttons */}
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              {/* Hint button */}
              {!isFeedbackPhase && (
                <button
                  onClick={useHint}
                  disabled={revealedHints.size >= 4}
                  className="px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm font-semibold hover:bg-amber-500/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <Lightbulb className="w-4 h-4" />
                  Hint (-50 pts)
                </button>
              )}
            </div>

            <div className="flex gap-3">
              {!isFeedbackPhase && (
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={checkAnswer}
                  disabled={!allLanesFilled}
                  className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-bold text-sm shadow-lg shadow-indigo-500/25 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  Check Answer
                </motion.button>
              )}

              {gamePhase === 'level-complete' && (
                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-center gap-4"
                >
                  <div className="text-right">
                    <p className="text-xs text-slate-500">Level Score</p>
                    <p className="text-lg font-black text-white">+{levelScore}</p>
                  </div>
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={nextLevel}
                    className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-bold text-sm shadow-lg shadow-emerald-500/25 flex items-center gap-2"
                  >
                    {currentLevel + 1 >= LEVELS.length ? 'See Results' : 'Next Level'}
                    <ChevronRight className="w-4 h-4" />
                  </motion.button>
                </motion.div>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// SHELL — story first, practice drill second.
// ═══════════════════════════════════════════════════════════════════

type GameMode = 'pick' | 'story' | 'practice';

export const GameView: React.FC<GameViewProps> = ({ onNavigateToBuilder, onExit }) => {
  const [mode, setMode] = useState<GameMode>('pick');

  if (mode === 'story') {
    return <StoryMode onExit={() => setMode('pick')} onNavigateToBuilder={onNavigateToBuilder} />;
  }

  if (mode === 'practice') {
    return <PracticeGame onExit={() => setMode('pick')} onNavigateToBuilder={onNavigateToBuilder} />;
  }

  return (
    <div className="h-full overflow-auto" style={{ background: '#171310' }}>
      <div className="max-w-4xl mx-auto px-6 py-10">
        <div className="flex items-start justify-between mb-8 gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] mb-2" style={{ color: FARM.honey }}>
              GAFS Challenge
            </p>
            <h1 className="text-3xl font-black text-white tracking-tight mb-2">
              Every chart is just 4 steps.
            </h1>
            <p className="text-sm max-w-xl leading-relaxed" style={{ color: '#9A8770' }}>
              Split it up. Add something up. Keep only the rows you want. Put them in order.
              That is all a chart is, and it is all Question Builder does. Learn the 4 steps here
              and the rest of the app makes sense.
            </p>
          </div>
          {onExit && (
            <button
              onClick={onExit}
              className="p-2 rounded-lg shrink-0 transition-colors hover:bg-white/10"
              style={{ color: '#9A8770' }}
              aria-label="Leave"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {/* Story mode — the front door */}
          <motion.button
            whileHover={{ y: -3 }}
            whileTap={{ scale: 0.995 }}
            onClick={() => setMode('story')}
            className="md:col-span-3 rounded-2xl overflow-hidden text-left border transition-colors"
            style={{ background: '#FFFFFF08', borderColor: '#FFFFFF1A' }}
          >
            <div className="h-44 relative">
              <FarmScene scene="sunrise-farm" className="w-full h-full" />
              <div
                className="absolute inset-0"
                style={{ background: 'linear-gradient(to bottom, rgba(23,19,16,0) 45%, rgba(23,19,16,0.85) 100%)' }}
              />
            </div>
            <div className="p-5 -mt-8 relative">
              <span
                className="text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-wider"
                style={{ background: FARM.honey, color: '#2E2318' }}
              >
                Start here
              </span>
              <h2 className="text-xl font-black text-white mt-3 mb-1.5">Sam's farm — a story in 6 chapters</h2>
              <p className="text-sm leading-relaxed mb-4" style={{ color: '#C9BBA8' }}>
                Sam sells 8 things in 3 places and has no idea which of it makes money. Help him work it
                out and you learn one step per chapter. Plain English, about 15 minutes.
              </p>
              <span className="inline-flex items-center gap-2 text-sm font-bold" style={{ color: FARM.honey }}>
                <Wheat className="w-4 h-4" /> Read the story <ChevronRight className="w-4 h-4" />
              </span>
            </div>
          </motion.button>

          {/* Practice drill */}
          <motion.button
            whileHover={{ y: -3 }}
            whileTap={{ scale: 0.995 }}
            onClick={() => setMode('practice')}
            className="md:col-span-2 rounded-2xl p-5 text-left border flex flex-col transition-colors"
            style={{ background: '#FFFFFF06', borderColor: '#FFFFFF14' }}
          >
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center mb-4"
              style={{ background: `${FARM.leaf}26` }}
            >
              <Gamepad2 className="w-5 h-5" style={{ color: '#9FC98A' }} />
            </div>
            <h2 className="text-lg font-black text-white mb-1.5">Quick practice</h2>
            <p className="text-sm leading-relaxed flex-1" style={{ color: '#9A8770' }}>
              10 timed questions from shops, hospitals and delivery firms. No story, just practice, with
              scores and streaks. Best once the 4 steps already make sense.
            </p>
            <span className="inline-flex items-center gap-2 text-sm font-bold mt-4" style={{ color: '#9FC98A' }}>
              <Play className="w-4 h-4" /> Start the drill <ChevronRight className="w-4 h-4" />
            </span>
          </motion.button>
        </div>

        {onNavigateToBuilder && (
          <button
            onClick={onNavigateToBuilder}
            className="w-full mt-4 py-3 rounded-xl text-sm font-semibold border transition-colors hover:bg-white/5 flex items-center justify-center gap-2"
            style={{ borderColor: '#FFFFFF14', background: '#FFFFFF06', color: '#9A8770' }}
          >
            <ArrowLeft className="w-4 h-4" /> Skip this and open Question Builder
          </button>
        )}
      </div>
    </div>
  );
};

export default GameView;
