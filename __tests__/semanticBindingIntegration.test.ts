import { describe, expect, it } from 'vitest';
import dataset from '../public/benchmarks/research-v1/datasets/bird--student-club--6dd31c5466.json';
import attendanceDataset from '../public/benchmarks/research-v1/datasets/bird--student-club--cce87c4e6a.json';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { generateLocalPlan } from '../services/ai-sql/intentPlanner';
import { discoverJoinContext } from '../services/ai-sql/joinEngine';
import {
    auditSqlPredicateProvenance,
    buildValueCatalog,
    groundFilters,
    groundQuestionLiterals,
    removeUnsupportedTopLevelPredicates,
} from '../services/ai-sql/valueGrounding';
import { buildQueryContract, validateSQLAgainstContract } from '../services/ai-sql/queryContract';

describe('privacy-preserving semantic binding integration', () => {
    it('binds the supplied major to its related table without treating members as a position', () => {
        const question = "How many members of the Student_Club have major in 'Physics Teaching'?\n\nEvidence: 'Physics Teaching' is the major_name;";
        const fixture = dataset as any;
        const model = buildSemanticModel(fixture);
        const plan = generateLocalPlan(question, model);
        const join = discoverJoinContext(fixture.relatedTables, fixture.sourceSchema)!;
        const catalog = buildValueCatalog(fixture.rows, model, 60, fixture.relatedTables);

        const literal = groundQuestionLiterals(question, fixture.rows, fixture.relatedTables, plan);
        plan.filters.push(...literal.added);
        const fuzzy = groundFilters(question, catalog, plan, model, { entityNames: join.tableNames });
        plan.filters.push(...fuzzy.added);

        expect(plan.filters).toContainEqual(expect.objectContaining({
            field: 'major_name',
            op: '=',
            value: 'Physics Teaching',
            grounding: expect.objectContaining({ table: 'major', confidence: 'exact' }),
        }));
        expect(plan.filters).not.toContainEqual(expect.objectContaining({ field: 'position', value: 'Member' }));

        const contract = buildQueryContract(
            question,
            plan,
            [],
            model,
            { tables: join.tables, links: join.links },
        );
        expect(contract.requiredTables).toEqual(expect.arrayContaining(['member', 'major']));
        expect(contract.requiredPredicates).toContainEqual(expect.objectContaining({
            table: 'major', field: 'major_name', value: 'Physics Teaching', confidence: 'high',
        }));
        expect(validateSQLAgainstContract(
            `SELECT COUNT(m.member_id)
             FROM member m
             JOIN major j ON m.link_to_major = j.major_id
             WHERE j.major_name = 'Physics Teaching'`,
            contract,
        )).toEqual([]);
    });

    it('rejects a source-domain name used as an invented row predicate before execution', () => {
        const question = 'Please list the phone numbers of the students from the Student_Club that has attended the event "Women\'s Soccer".';
        const fixture = attendanceDataset as any;
        const model = buildSemanticModel(fixture);
        const catalog = buildValueCatalog(fixture.rows, model, 60, fixture.relatedTables);
        const candidate = `SELECT member.phone
            FROM member
            INNER JOIN attendance ON member.member_id = attendance.link_to_member
            INNER JOIN event ON attendance.link_to_event = event.event_id
            WHERE member.position = 'Student_Club'
              AND event.event_name = 'Women''s Soccer'`;

        const issues = auditSqlPredicateProvenance(candidate, catalog, { question });
        expect(issues).toEqual([{
            field: 'member.position',
            literal: 'Student_Club',
            operator: '=',
        }]);

        const repaired = removeUnsupportedTopLevelPredicates(candidate, issues);
        expect(repaired.removed).toEqual(issues);
        expect(repaired.sql).not.toContain('member.position');
        expect(repaired.sql).toContain("event.event_name = 'Women''s Soccer'");

        // The surviving relational path identifies all 17 attendees, including
        // officers/inactive records that the invented position filter erased.
        const event = fixture.relatedTables.find((table: any) => table.name === 'event').rows
            .find((row: any) => row.event_name === "Women's Soccer");
        const attendance = fixture.relatedTables.find((table: any) => table.name === 'attendance').rows
            .filter((row: any) => row.link_to_event === event.event_id);
        expect(attendance).toHaveLength(17);
    });

    it('preserves explicit no-match requests and refuses to rewrite complex boolean logic', () => {
        const fixture = attendanceDataset as any;
        const model = buildSemanticModel(fixture);
        const catalog = buildValueCatalog(fixture.rows, model, 60, fixture.relatedTables);
        const explicitQuestion = 'List phone numbers where position is "Student_Club".';
        const explicitSQL = "SELECT phone FROM member WHERE position = 'Student_Club'";
        expect(auditSqlPredicateProvenance(explicitSQL, catalog, { question: explicitQuestion })).toEqual([]);

        const complexSQL = "SELECT phone FROM member WHERE position = 'Student_Club' OR position = 'Member'";
        const issues = auditSqlPredicateProvenance(complexSQL, catalog, { question: 'List phone numbers.' });
        expect(issues).toHaveLength(1);
        expect(removeUnsupportedTopLevelPredicates(complexSQL, issues)).toEqual({ sql: complexSQL, removed: [] });
    });
});
