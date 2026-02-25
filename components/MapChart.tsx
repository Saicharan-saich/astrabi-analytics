import React, { useMemo } from 'react';
import { ComposableMap, Geographies, Geography, ZoomableGroup, Marker } from 'react-simple-maps';
import { scaleLinear } from 'd3-scale';
import { geoCentroid } from 'd3-geo';
import { formatNumber } from '../utils/chartUtils';

// Standard World Map TopoJSON
const GEO_WORLD = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json";
// US States TopoJSON
const GEO_US = "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json";

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
}

export const MapChart: React.FC<MapChartProps> = ({ data, locationKey, valueKey, labelContent = 'value', onTooltip }) => {
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
                if (loc === 'usa' || loc === 'us' || loc === 'united states of america') loc = 'united states';
                if (loc === 'uk' || loc === 'great britain') loc = 'united kingdom';
            }

            map[loc] = val;
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
        .domain([min, max])
        .range(["#E0F2FE", "#0284C7"]);

    return (
        <div className="w-full h-full min-h-[400px] bg-slate-50 rounded-xl overflow-hidden border border-slate-100 relative">
            <ComposableMap
                projection={isUSMap ? "geoAlbersUsa" : "geoMercator"}
                projectionConfig={isUSMap ? { scale: 1000 } : { scale: 100 }}
            >
                <ZoomableGroup center={isUSMap ? [0, 0] : [0, 20]} zoom={1}>
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
                                            fill={hasData ? colorScale(value) : "#F1F5F9"}
                                            stroke="#CBD5E1"
                                            strokeWidth={0.5}
                                            style={{
                                                default: { outline: "none" },
                                                hover: {
                                                    fill: hasData ? "#0EA5E9" : "#E2E8F0",
                                                    outline: "none",
                                                    cursor: hasData ? "pointer" : "default"
                                                },
                                                pressed: { outline: "none" },
                                            }}
                                            onMouseEnter={() => {
                                                if (onTooltip) {
                                                    const dispName = geo.properties.name;
                                                    const valDisplay = hasData ? formatNumber(value) : 'No Data';
                                                    onTooltip(`${dispName}: ${valDisplay}`);
                                                }
                                            }}
                                            onMouseLeave={() => {
                                                if (onTooltip) onTooltip('');
                                            }}
                                        />
                                    );
                                })}
                                {geographies.map((geo) => {
                                    const name = (geo.properties.name as string).toLowerCase();
                                    const value = dataMap[name];
                                    if (value === undefined) return null;

                                    const centroid = geoCentroid(geo);
                                    if (!centroid) return null;

                                    const shortName = isUSMap ? (STATE_CODES[name] || name.substring(0, 2).toUpperCase()) : name;
                                    const formattedVal = formatNumber(value, { numberFormat: 'compact' } as any); // Compact

                                    return (
                                        <Marker coordinates={centroid} key={geo.rsmKey + "-label"}>
                                            <text
                                                textAnchor="middle"
                                                y={isUSMap ? 0 : 4}
                                                style={{
                                                    fontFamily: "Inter, sans-serif",
                                                    fontSize: isUSMap ? "8px" : "5px",
                                                    fill: "#0f172a", // Slate-900
                                                    fontWeight: "bold",
                                                    pointerEvents: "none",
                                                    textShadow: "0px 0px 3px rgba(255,255,255,0.9)"
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

            <div className="absolute bottom-4 left-4 bg-white/90 backdrop-blur p-2 rounded-lg shadow border border-slate-100 text-xs">
                <div className="font-semibold text-slate-700 mb-1">{isUSMap ? 'US Sales' : 'Global Sales'}</div>
                <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-[#E0F2FE] border border-slate-200"></div>
                    <span className="text-slate-500">{formatNumber(min)}</span>
                </div>
                <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-[#0284C7]"></div>
                    <span className="text-slate-500">{formatNumber(max)}</span>
                </div>
            </div>
        </div>
    );
};
