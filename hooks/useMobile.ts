import { useState, useEffect } from 'react';

/**
 * Hook to detect mobile and tablet breakpoints.
 * Uses matchMedia for efficient, event-driven detection.
 * Breakpoints:
 *   - mobile: <= 768px
 *   - tablet: 769px – 1024px
 *   - desktop: > 1024px
 */
export function useMobile() {
  const [isMobile, setIsMobile] = useState(false);
  const [isTablet, setIsTablet] = useState(false);

  useEffect(() => {
    const mobileQuery = window.matchMedia('(max-width: 768px)');
    const tabletQuery = window.matchMedia('(min-width: 769px) and (max-width: 1024px)');

    const handleChange = () => {
      setIsMobile(mobileQuery.matches);
      setIsTablet(tabletQuery.matches);
    };

    // Set initial values
    handleChange();

    // Listen for changes
    mobileQuery.addEventListener('change', handleChange);
    tabletQuery.addEventListener('change', handleChange);

    return () => {
      mobileQuery.removeEventListener('change', handleChange);
      tabletQuery.removeEventListener('change', handleChange);
    };
  }, []);

  return { isMobile, isTablet, isDesktop: !isMobile && !isTablet };
}
