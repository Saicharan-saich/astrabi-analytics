import React, { useMemo } from 'react';
import { ComposableMap, Geographies, Geography, ZoomableGroup, Marker } from 'react-simple-maps';
import { scaleLinear } from 'd3-scale';
import { geoCentroid } from 'd3-geo';
import { formatNumber } from '../utils/chartUtils';
import { COUNTRY_ALIASES } from '../utils/chartSuggestions';

// Standard World Map TopoJSON
const GEO_WORLD = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json";
// US States TopoJSON
const GEO_US = "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json";

// When every country with data is in Europe, zoom there instead of showing
// a world of empty land.
const EUROPE = new Set(['albania', 'austria', 'belarus', 'belgium', 'bosnia and herz.', 'bulgaria', 'croatia', 'cyprus', 'czechia', 'denmark', 'estonia', 'finland', 'france', 'germany', 'greece', 'hungary', 'iceland', 'ireland', 'italy', 'latvia', 'lithuania', 'luxembourg', 'moldova', 'montenegro', 'netherlands', 'north macedonia', 'norway', 'poland', 'portugal', 'romania', 'serbia', 'slovakia', 'slovenia', 'spain', 'sweden', 'switzerland', 'ukraine', 'united kingdom']);

const US_STATES = new Set([
    'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia',
    'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts',
    'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
    'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island',
    'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia',
    'wisconsin', 'wyoming', 'district of columbia', 'puerto rico'
]);

const STATE_CODES: Record<string, string> = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'florida': 'FL', 'georgia': 'GA',
    'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD', 'massachusetts': 'MA',
    'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
    'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI',
    'south carolina': 'SC', 'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
    'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC', 'puerto rico': 'PR'
};

interface MapChartProps {
    data: any[];
    locationKey: string;
    valueKey: string;
    labelContent?: 'value' | 'name' | 'both';
    onTooltip?: (content: string) => void;
    /** Legend title, e.g. "Revenue". */
    valueLabel?: string;
    isDark?: boolean;
}

export const MapChart: React.FC<MapChartProps> = ({ data, locationKey, valueKey, labelContent = 'value', onTooltip, valueLabel, isDark = false }) => {
    const [hovered, setHovered] = React.useState('');
    // 1. Geography Mode Detection & Data Processing
    const { isUSMap, dataMap, min, max } = useMemo(() => {
        let usMatches = 0;
        let minVal = Infinity;
        let maxVal = -Infinity;
        const map: Record<string, number> = {};

        data.forEach(row => {
            const rawLoc = String(row[locationKey] || '').trim().toLowerCase();
            let loc = rawLoc;
            const val = Number(row[valueKey]) || 0;

            if (val < minVal) minVal = val;
            if (val > maxVal) maxVal = val;

            if (US_STATES.has(loc)) {
                usMatches++;
            } else {
                // Match the world map's own names ("United States of America").
                loc = COUNTRY_ALIASES[loc] || loc;
            }

            map[loc] = (map[loc] || 0) + val;
        });

        const isUS = (data.length > 0 && usMatches / data.length > 0.3) || locationKey.toLowerCase().includes('state');

        return {
            isUSMap: isUS,
            dataMap: map,
            min: minVal === Infinity ? 0 : minVal,
            max: maxVal === -Infinity ? 100 : maxVal
        };
    }, [data, locationKey, valueKey]);

    const geoUrl = isUSMap ? GEO_US : GEO_WORLD;

    const colorScale = scaleLinear<string>()
        .domain([min, max === min ? min + 1 : max])
        .range(isDark ? ['#24406b', '#7aa5ff'] : ['#dbe6ff', '#2c55c8']);
    const emptyFill = isDark ? '#1f232c' : '#eef1f5';
    const strokeColour = isDark ? '#0e1015' : '#ffffff';
    const plotted = Object.keys(dataMap).length;
    // World maps get crowded: label countries only when there are few.
    const showLabels = isUSMap || plotted <= 12;
    const europeOnly = !isUSMap && plotted > 0 && Object.keys(dataMap).every(name => EUROPE.has(name));
    // Wide frames suit a chart card; the SVG then scales to fit both ways.
    const frame = isUSMap ? { width: 800, height: 500 } : { width: 800, height: 440 };
    const projectionConfig = isUSMap
        ? { scale: 1000 }
        : europeOnly ? { scale: 700, rotate: [-12, -53, 0] as [number, number, number] } : { scale: 150 };
    const viewCentre: [number, number] = isUSMap ? [-97, 38] : europeOnly ? [12, 53] : [10, 18];
    const report = (text: string) => { setHovered(text); onTooltip?.(text); };

    return (
        <div className="qi-map w-full h-full min-h-[200px] rounded-xl overflow-hidden relative">
            <ComposableMap
                projection={isUSMap ? "geoAlbersUsa" : europeOnly ? "geoAzimuthalEqualArea" : "geoEqualEarth"}
                projectionConfig={projectionConfig}
                width={frame.width}
                height={frame.height}
                style={{ width: '100%', height: '100%', display: 'block' }}
            >
                <ZoomableGroup center={viewCentre} zoom={1}>
                    <Geographies geography={geoUrl}>
                        {({ geographies }) => (
                            <>
                                {geographies.map((geo) => {
                                    const name = (geo.properties.name as string).toLowerCase();
                                    const value = dataMap[name];
                                    const hasData = value !== undefined;

                                    return (
                                        <Geography
                                            key={geo.rsmKey}
                                            geography={geo}
                                            fill={hasData ? colorScale(value) : emptyFill}
                                            stroke={strokeColour}
                                            strokeWidth={0.6}
                                            style={{
                                                default: { outline: "none" },
                                                hover: {
                                                    fill: hasData ? (isDark ? '#a9c3ff' : '#3565e8') : emptyFill,
                                                    outline: "none",
                                                    cursor: hasData ? "pointer" : "default"
                                                },
                                                pressed: { outline: "none" },
                                            }}
                                            onMouseEnter={() => {
                                                const dispName = geo.properties.name;
                                                report(hasData ? `${dispName}: ${formatNumber(value)}` : `${dispName}: no data`);
                                            }}
                                            onMouseLeave={() => report('')}
                                        />
                                    );
                                })}
                                {geographies.map((geo) => {
                                    const name = (geo.properties.name as string).toLowerCase();
                                    const value = dataMap[name];
                                    if (value === undefined || !showLabels) return null;

                                    const centroid = geoCentroid(geo);
                                    if (!centroid) return null;

                                    const shortName = isUSMap ? (STATE_CODES[name] || name.substring(0, 2).toUpperCase()) : String(geo.properties.name);
                                    const formattedVal = formatNumber(value, { numberFormat: 'compact' } as any); // Compact

                                    return (
                                        <Marker coordinates={centroid} key={geo.rsmKey + "-label"}>
                                            <text
                                                textAnchor="middle"
                                                y={isUSMap ? 0 : 4}
                                                style={{
                                                    fontFamily: "Inter, sans-serif",
                                                    fontSize: isUSMap ? "8px" : "5px",
                                                    fill: isDark ? '#e8eaef' : '#1f2430',
                                                    fontWeight: 600,
                                                    pointerEvents: "none",
                                                    textShadow: isDark ? '0 0 3px rgba(0,0,0,0.8)' : '0 0 3px rgba(255,255,255,0.95)'
                                                }}
                                            >
                                                {labelContent === 'both' ? (
                                                    <>
                                                        <tspan x="0" dy="-0.4em">{shortName}</tspan>
                                                        <tspan x="0" dy="1.0em" fontSize={isUSMap ? "7px" : "4px"} fontWeight="normal">{formattedVal}</tspan>
                                                    </>
                                                ) : labelContent === 'name' ? (
                                                    shortName
                                                ) : (
                                                    formattedVal
                                                )}
                                            </text>
                                        </Marker>
                                    );
                                })}
                            </>
                        )}
                    </Geographies>
                </ZoomableGroup>
            </ComposableMap>

            {hovered && (
                <div className="qi-map-hover absolute top-3 left-3 rounded-md px-2.5 py-1.5 text-xs font-medium pointer-events-none">{hovered}</div>
            )}
            <div className="qi-map-legend absolute bottom-3 left-3 rounded-md px-2.5 py-2 text-[11px]">
                <div className="qi-map-legend-title mb-1 font-semibold">{valueLabel || 'Value'}</div>
                <div className="flex items-center gap-2">
                    <span className="tabular-nums">{formatNumber(min)}</span>
                    <span className="h-2 w-20 rounded-full" style={{ background: `linear-gradient(90deg, ${colorScale(min)}, ${colorScale(max === min ? min + 1 : max)})` }} />
                    <span className="tabular-nums">{formatNumber(max)}</span>
                </div>
            </div>
        </div>
    );
};
