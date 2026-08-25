import { describe, expect, it } from 'vitest';
import dataset from '../public/benchmarks/research-v1/datasets/bird--student-club--6dd31c5466.json';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { generateLocalPlan } from '../services/ai-sql/intentPlanner';
import { discoverJoinContext } from '../services/ai-sql/joinEngine';
import { buildValueCatalog, groundFilters, groundQuestionLiterals } from '../services/ai-sql/valueGrounding';
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
});
