import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * SplashScreen – shows the QuickInsight logo centered on a dark background
 * for a configurable duration (default 5 s), then fades out with a smooth
 * scale-and-opacity transition reminiscent of the Windows boot logo.
 */
export const SplashScreen: React.FC<{ onComplete: () => void }> = ({ onComplete }) => {
    const [visible, setVisible] = useState(true);

    useEffect(() => {
        const timer = setTimeout(() => setVisible(false), 4200); // start fade-out a bit before 5 s
        return () => clearTimeout(timer);
    }, []);

    return (
        <AnimatePresence onExitComplete={onComplete}>
            {visible && (
                <motion.div
                    key="splash"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, scale: 1.08 }}
                    transition={{ duration: 0.9, ease: 'easeInOut' }}
                    className="fixed inset-0 z-[9999] flex flex-col items-center justify-center"
                    style={{ background: 'linear-gradient(145deg, #0b0e1a 0%, #141825 50%, #0f1222 100%)' }}
                >
                    {/* Subtle radial glow behind logo */}
                    <div
                        className="absolute rounded-full blur-3xl opacity-30"
                        style={{
                            width: 400,
                            height: 400,
                            background: 'radial-gradient(circle, rgba(99,102,241,0.5) 0%, transparent 70%)',
                        }}
                    />

                    {/* Logo with entrance animation */}
                    <motion.img
                        src="/logo.jpg"
                        alt="QuickInsight"
                        className="w-28 h-28 rounded-3xl object-cover shadow-2xl relative z-10"
                        initial={{ opacity: 0, scale: 0.6, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        transition={{ delay: 0.2, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                    />

                    {/* Brand name */}
                    <motion.h1
                        className="mt-6 text-3xl font-bold tracking-tight text-white relative z-10"
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.6, duration: 0.6, ease: 'easeOut' }}
                    >
                        Quick<span className="text-emerald-400">Insight</span>
                    </motion.h1>

                    {/* Tagline */}
                    <motion.p
                        className="mt-2 text-sm text-gray-400 tracking-wide relative z-10"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 1.0, duration: 0.6 }}
                    >
                        Self-Service Exploratory Analytics
                    </motion.p>

                    {/* Animated loading dots */}
                    <motion.div
                        className="mt-10 flex gap-1.5 relative z-10"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 1.4, duration: 0.4 }}
                    >
                        {[0, 1, 2].map(i => (
                            <motion.div
                                key={i}
                                className="w-1.5 h-1.5 rounded-full bg-violet-400"
                                animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.2, 0.8] }}
                                transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2, ease: 'easeInOut' }}
                            />
                        ))}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};
