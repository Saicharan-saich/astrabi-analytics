/**
 * Approximate [longitude, latitude] of each country's main landmass, keyed by
 * the lower-cased world-map name (see resolveCountryName). Used to frame a map
 * around the countries that have data instead of always showing the world.
 */
export const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
    'afghanistan': [66, 34], 'albania': [20, 41], 'algeria': [3, 28], 'angola': [18, -12], 'argentina': [-64, -34],
    'armenia': [45, 40], 'australia': [134, -25], 'austria': [14, 47.5], 'azerbaijan': [48, 40.3], 'bangladesh': [90, 24],
    'belarus': [28, 53.5], 'belgium': [4.5, 50.6], 'bolivia': [-64.5, -16.5], 'bosnia and herz.': [17.8, 44.2], 'botswana': [24, -22],
    'brazil': [-52, -10], 'bulgaria': [25.3, 42.7], 'cambodia': [105, 12.5], 'cameroon': [12.5, 5.5], 'canada': [-100, 56],
    'chile': [-71, -33], 'china': [104, 35], 'colombia': [-73, 4], 'costa rica': [-84, 10], 'croatia': [16, 45.3],
    'cuba': [-79, 21.7], 'cyprus': [33.2, 35], 'czechia': [15.4, 49.8], 'denmark': [9.5, 56], 'dominican rep.': [-70.5, 18.8],
    'ecuador': [-78.5, -1.5], 'egypt': [30, 27], 'estonia': [25.5, 58.7], 'ethiopia': [39.5, 8.5], 'finland': [26, 64],
    'france': [2.5, 46.5], 'georgia': [43.5, 42.2], 'germany': [10.4, 51.1], 'ghana': [-1.2, 7.9], 'greece': [22, 39.2],
    'guatemala': [-90.3, 15.6], 'hungary': [19.5, 47.2], 'iceland': [-18.5, 65], 'india': [79, 22], 'indonesia': [117, -2],
    'iran': [54, 32.5], 'iraq': [43.7, 33], 'ireland': [-8, 53.3], 'israel': [35, 31.4], 'italy': [12.5, 42.8],
    'jamaica': [-77.3, 18.1], 'japan': [138, 37], 'jordan': [36.5, 31], 'kazakhstan': [67, 48], 'kenya': [38, 0.2],
    'kuwait': [47.7, 29.3], 'latvia': [24.9, 56.9], 'lebanon': [35.9, 33.9], 'libya': [17, 27], 'lithuania': [23.9, 55.3],
    'luxembourg': [6.1, 49.8], 'madagascar': [46.7, -19.4], 'malaysia': [109, 3.5], 'mexico': [-102, 23.6], 'mongolia': [103, 46.8],
    'morocco': [-6.5, 31.8], 'mozambique': [35.5, -18], 'myanmar': [96, 21], 'nepal': [84, 28.3], 'netherlands': [5.4, 52.2],
    'new zealand': [172, -41.5], 'nicaragua': [-85, 12.9], 'nigeria': [8.7, 9.1], 'north korea': [127.2, 40.1], 'norway': [9, 61.5],
    'oman': [56, 21], 'pakistan': [69.3, 30], 'panama': [-80, 8.5], 'paraguay': [-58.4, -23.4], 'peru': [-75, -9.2],
    'philippines': [122, 12.5], 'poland': [19.4, 52], 'portugal': [-8.2, 39.6], 'qatar': [51.2, 25.3], 'romania': [25, 45.9],
    'russia': [90, 61], 'saudi arabia': [45, 24], 'senegal': [-14.5, 14.5], 'serbia': [20.9, 44], 'singapore': [103.8, 1.35],
    'slovakia': [19.7, 48.7], 'slovenia': [14.9, 46.1], 'somalia': [46, 5.2], 'south africa': [24.5, -29], 'south korea': [127.8, 36.3],
    'spain': [-3.7, 40.2], 'sri lanka': [80.7, 7.8], 'sudan': [30, 15.5], 'sweden': [16, 62.5], 'switzerland': [8.2, 46.8],
    'syria': [38.5, 35], 'taiwan': [121, 23.7], 'tanzania': [35, -6.4], 'thailand': [101, 15.5], 'tunisia': [9.5, 34],
    'turkey': [35, 39], 'uganda': [32.3, 1.4], 'ukraine': [31.2, 49], 'united arab emirates': [54.2, 23.9], 'united kingdom': [-2.5, 54],
    'united states of america': [-98, 39], 'uruguay': [-56, -32.8], 'uzbekistan': [64.5, 41.4], 'venezuela': [-66.5, 7],
    'vietnam': [106.3, 16], 'yemen': [47.5, 15.6], 'zambia': [27.8, -13.1], 'zimbabwe': [29.8, -19],
};

/**
 * Centre and zoom that frame the given countries on a map drawn with `project`
 * into a width × height frame. Returns null (show the whole world) when a
 * country is unknown or the countries already span most of the world.
 */
export function frameCountries(
    names: string[],
    project: (point: [number, number]) => [number, number] | null,
    width: number,
    height: number,
): { center: [number, number]; zoom: number } | null {
    const points = names.map(name => COUNTRY_CENTROIDS[name]);
    if (points.length === 0 || points.some(point => !point)) return null;
    const projected = points.map(point => project(point)).filter((p): p is [number, number] => Array.isArray(p));
    if (projected.length !== points.length) return null;
    const xs = projected.map(p => p[0]);
    const ys = projected.map(p => p[1]);
    // Pad each side so the countries' own outlines fit, not just their centres.
    const spanX = Math.max(...xs) - Math.min(...xs) + width * 0.16;
    const spanY = Math.max(...ys) - Math.min(...ys) + height * 0.22;
    const zoom = Math.max(1, Math.min(6, Math.min(width / spanX, height / spanY)));
    if (zoom < 1.4) return null; // barely closer than the world view: keep the world
    const lons = points.map(p => p![0]);
    const lats = points.map(p => p![1]);
    return {
        center: [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2],
        zoom,
    };
}
