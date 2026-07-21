/**
 * Foreign-key-aware denormalization — the "multi-join capable" path.
 * Proves that reading declared FKs (even when key names differ across tables,
 * like BIRD's satscores.cds → schools.CDSCode) lets autoJoinDatasets build ONE
 * wide master table containing every column, so the single-table engine can then
 * answer multi-table questions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import { readSqliteForeignKeys, readSqliteTables, buildBirdCases, BirdQuestion } from '../services/benchmark/birdLoader';
import { autoJoinDatasets } from '../services/analysisEngine';

let SQL: any;
let bytes: Uint8Array;

beforeAll(async () => {
    SQL = await initSqlJs();
    const db = new SQL.Database();
    // A BIRD-like star: satscores and frpm both reference schools, with
    // DIFFERENTLY NAMED keys (satscores.cds vs schools.CDSCode).
    db.run(`
        CREATE TABLE schools (CDSCode TEXT, School TEXT, Virtual TEXT);
        INSERT INTO schools VALUES ('A','Alpha','F'),('B','Beta','P'),('C','Gamma','F');
        CREATE TABLE satscores (cds TEXT, AvgScrMath INTEGER,
            FOREIGN KEY (cds) REFERENCES schools(CDSCode));
        INSERT INTO satscores VALUES ('A',450),('B',300),('C',600);
        CREATE TABLE frpm ("CDSCode" TEXT, "Charter School (Y/N)" INTEGER,
            FOREIGN KEY ("CDSCode") REFERENCES schools(CDSCode));
        INSERT INTO frpm VALUES ('A',1),('B',0),('C',1);
    `);
    bytes = db.export();
    db.close();
});

describe('readSqliteForeignKeys', () => {
    it('discovers FK edges with the real (differently-named) key columns', () => {
        const edges = readSqliteForeignKeys(SQL, bytes);
        // satscores.cds → schools.CDSCode
        expect(edges).toEqual(expect.arrayContaining([
            expect.objectContaining({ leftTable: 'satscores', rightTable: 'schools', leftColumn: 'cds', rightColumn: 'CDSCode' }),
            expect.objectContaining({ leftTable: 'frpm', rightTable: 'schools', leftColumn: 'CDSCode', rightColumn: 'CDSCode' }),
        ]));
    });
});

describe('FK-aware denormalization builds a complete wide master', () => {
    it('joins satscores + frpm onto schools even with mismatched key names', () => {
        const tables = readSqliteTables(SQL, bytes);
        const edges = readSqliteForeignKeys(SQL, bytes);
        const tableMap: Record<string, any[]> = {};
        for (const [name, rows] of Object.entries(tables)) tableMap[name] = rows;

        const { mergedRows } = autoJoinDatasets(tableMap, edges);
        expect(mergedRows.length).toBe(3); // schools grain, 1:1 joins → no fan-out
        const cols = Object.keys(mergedRows[0]);
        // The master must contain columns from ALL three tables.
        expect(cols).toEqual(expect.arrayContaining(['School', 'Virtual', 'AvgScrMath', 'Charter School (Y/N)']));

        // And the values line up per school (the join actually connected them).
        const alpha = mergedRows.find(r => r.School === 'Alpha');
        expect(Number(alpha.AvgScrMath)).toBe(450);
        expect(Number(alpha['Charter School (Y/N)'])).toBe(1);
    });
});

describe('buildBirdCases attaches the FK join edges to multi-table cases', () => {
    it('sets joinEdges from the database foreign keys', () => {
        const databases = { california_schools: readSqliteTables(SQL, bytes) };
        const fks = { california_schools: readSqliteForeignKeys(SQL, bytes) };
        const questions: BirdQuestion[] = [{
            db_id: 'california_schools',
            question: 'How many virtual schools have a math score over 400?',
            SQL: "SELECT COUNT(*) FROM satscores JOIN schools ON satscores.cds = schools.CDSCode WHERE schools.Virtual='F' AND satscores.AvgScrMath>400",
            difficulty: 'simple',
        }];
        const [c] = buildBirdCases(questions, databases, fks);
        expect(c.tableCount).toBe(2);
        expect(c.joinEdges && c.joinEdges.length).toBeGreaterThan(0);
    });
});
