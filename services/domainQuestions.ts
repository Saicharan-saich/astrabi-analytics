/**
 * domainQuestions.ts — Multi-Domain Question Registry
 * 30+ predefined questions per industry domain.
 * Questions use semantic role references (not hardcoded column names).
 */
import { QuestionTemplate } from "../types";

// ╔══════════════════════════════════════════════════════════════════╗
// ║  HR DOMAIN — 30 Questions                                      ║
// ╚══════════════════════════════════════════════════════════════════╝
const HR_QUESTIONS: QuestionTemplate[] = [
    { id: 'hr_headcount', domain: 'HR', category: 'Headcount & Composition', question: 'Current total headcount', req: ['customer_id', 'order_date'], grain: 'day', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'hr_hc_dept', domain: 'HR', category: 'Headcount & Composition', question: 'Headcount by department', req: ['customer_name', 'customer_id', 'order_date'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hr_hc_trend', domain: 'HR', category: 'Headcount & Composition', question: 'Headcount trend (monthly)', req: ['customer_id', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'hr_hc_location', domain: 'HR', category: 'Headcount & Composition', question: 'Headcount by location', req: ['region', 'customer_id'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hr_hc_type', domain: 'HR', category: 'Headcount & Composition', question: 'Full-time vs part-time split', req: ['category', 'customer_id'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },
    { id: 'hr_new_hires', domain: 'HR', category: 'Headcount & Composition', question: 'New hires this month', req: ['customer_id', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'hr_tenure', domain: 'HR', category: 'Headcount & Composition', question: 'Average employee tenure', req: ['revenue', 'order_date'], grain: 'any', vis: 'kpiCard', sql: '...', evalType: 'kpi' },

    { id: 'hr_attrition', domain: 'HR', category: 'Attrition & Retention', question: 'Monthly attrition rate', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'hr_attrition_dept', domain: 'HR', category: 'Attrition & Retention', question: 'Attrition by department', req: ['customer_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hr_turnover', domain: 'HR', category: 'Attrition & Retention', question: 'Employee turnover rate (YTD)', req: ['revenue', 'order_date'], grain: 'year', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'hr_exit_trend', domain: 'HR', category: 'Attrition & Retention', question: 'Exit trend over time', req: ['customer_id', 'order_date'], grain: 'month', vis: 'area', sql: '...', evalType: 'trend' },
    { id: 'hr_retention', domain: 'HR', category: 'Attrition & Retention', question: 'Retention rate by department', req: ['customer_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hr_voluntary', domain: 'HR', category: 'Attrition & Retention', question: 'Voluntary vs involuntary exits', req: ['category', 'customer_id'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },

    { id: 'hr_avg_salary', domain: 'HR', category: 'Compensation & Benefits', question: 'Average salary by department', req: ['customer_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hr_salary_trend', domain: 'HR', category: 'Compensation & Benefits', question: 'Salary cost trend (monthly)', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'hr_total_payroll', domain: 'HR', category: 'Compensation & Benefits', question: 'Total payroll cost this month', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'hr_salary_range', domain: 'HR', category: 'Compensation & Benefits', question: 'Salary distribution', req: ['revenue', 'customer_name'], grain: 'any', vis: 'bar', sql: '...', evalType: 'ranking' },
    { id: 'hr_overtime', domain: 'HR', category: 'Compensation & Benefits', question: 'Overtime hours by department', req: ['quantity', 'customer_name'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hr_benefits_cost', domain: 'HR', category: 'Compensation & Benefits', question: 'Benefits cost breakdown', req: ['revenue', 'category'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },

    { id: 'hr_diversity', domain: 'HR', category: 'Diversity & Inclusion', question: 'Gender distribution', req: ['category', 'customer_id'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },
    { id: 'hr_div_dept', domain: 'HR', category: 'Diversity & Inclusion', question: 'Diversity by department', req: ['customer_name', 'category', 'customer_id'], grain: 'any', vis: 'groupedBar', sql: '...', evalType: 'comparison' },
    { id: 'hr_age_dist', domain: 'HR', category: 'Diversity & Inclusion', question: 'Age group distribution', req: ['category', 'customer_id'], grain: 'any', vis: 'bar', sql: '...', evalType: 'ranking' },
    { id: 'hr_div_trend', domain: 'HR', category: 'Diversity & Inclusion', question: 'Diversity trend over time', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },

    { id: 'hr_perf_rating', domain: 'HR', category: 'Performance & Engagement', question: 'Performance rating distribution', req: ['rating', 'customer_id'], grain: 'any', vis: 'bar', sql: '...', evalType: 'ranking' },
    { id: 'hr_top_perf', domain: 'HR', category: 'Performance & Engagement', question: 'Top performers by department', req: ['customer_name', 'rating'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hr_engagement', domain: 'HR', category: 'Performance & Engagement', question: 'Employee engagement score', req: ['rating', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'hr_training', domain: 'HR', category: 'Performance & Engagement', question: 'Training hours per employee', req: ['quantity', 'customer_name'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hr_promo_rate', domain: 'HR', category: 'Performance & Engagement', question: 'Promotion rate by department', req: ['customer_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hr_satisfaction', domain: 'HR', category: 'Performance & Engagement', question: 'Satisfaction score trend', req: ['rating', 'order_date'], grain: 'month', vis: 'curvedLine', sql: '...', evalType: 'trend' },
    { id: 'hr_absenteeism', domain: 'HR', category: 'Performance & Engagement', question: 'Absenteeism rate by department', req: ['customer_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hr_hc_vs_lm', domain: 'HR', category: 'Headcount & Composition', question: 'Headcount vs last month', req: ['customer_id', 'order_date'], grain: 'month', vis: 'groupedBar', sql: '...', evalType: 'comparison' },
];

// ╔══════════════════════════════════════════════════════════════════╗
// ║  FINANCE DOMAIN — 30 Questions                                 ║
// ╚══════════════════════════════════════════════════════════════════╝
const FINANCE_QUESTIONS: QuestionTemplate[] = [
    { id: 'fin_total_rev', domain: 'Finance', category: 'Revenue & Income', question: 'Total revenue this month', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'fin_rev_trend', domain: 'Finance', category: 'Revenue & Income', question: 'Revenue trend (monthly)', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'fin_rev_vs_lm', domain: 'Finance', category: 'Revenue & Income', question: 'Revenue vs last month', req: ['revenue', 'order_date'], grain: 'month', vis: 'groupedBar', sql: '...', evalType: 'comparison' },
    { id: 'fin_rev_by_cat', domain: 'Finance', category: 'Revenue & Income', question: 'Revenue by category', req: ['revenue', 'product_name'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'fin_rev_ytd', domain: 'Finance', category: 'Revenue & Income', question: 'Year-to-date revenue', req: ['revenue', 'order_date'], grain: 'year', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'fin_rev_share', domain: 'Finance', category: 'Revenue & Income', question: 'Revenue share by segment', req: ['revenue', 'product_name'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },

    { id: 'fin_total_exp', domain: 'Finance', category: 'Expenses & Costs', question: 'Total expenses this month', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'fin_exp_trend', domain: 'Finance', category: 'Expenses & Costs', question: 'Expense trend (monthly)', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'fin_exp_cat', domain: 'Finance', category: 'Expenses & Costs', question: 'Expenses by category', req: ['revenue', 'product_name'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'fin_exp_share', domain: 'Finance', category: 'Expenses & Costs', question: 'Expense distribution', req: ['revenue', 'product_name'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },
    { id: 'fin_exp_vs_lm', domain: 'Finance', category: 'Expenses & Costs', question: 'Expenses vs last month', req: ['revenue', 'order_date'], grain: 'month', vis: 'groupedBar', sql: '...', evalType: 'comparison' },

    { id: 'fin_net_income', domain: 'Finance', category: 'Profitability & Margins', question: 'Net income this month', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'fin_profit_trend', domain: 'Finance', category: 'Profitability & Margins', question: 'Profit margin trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'fin_margin_cat', domain: 'Finance', category: 'Profitability & Margins', question: 'Profit margin by segment', req: ['revenue', 'product_name'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'fin_gross_margin', domain: 'Finance', category: 'Profitability & Margins', question: 'Gross margin percentage', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'fin_ebitda', domain: 'Finance', category: 'Profitability & Margins', question: 'EBITDA trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'curvedLine', sql: '...', evalType: 'trend' },

    { id: 'fin_cashflow', domain: 'Finance', category: 'Cash Flow', question: 'Net cash flow this month', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'fin_cf_trend', domain: 'Finance', category: 'Cash Flow', question: 'Cash flow trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'area', sql: '...', evalType: 'trend' },
    { id: 'fin_cf_in_out', domain: 'Finance', category: 'Cash Flow', question: 'Cash inflow vs outflow', req: ['revenue', 'order_date'], grain: 'month', vis: 'groupedBar', sql: '...', evalType: 'comparison' },

    { id: 'fin_bva_rev', domain: 'Finance', category: 'Budget vs Actual', question: 'Budget vs actual revenue', req: ['revenue', 'order_date'], grain: 'month', vis: 'groupedBar', sql: '...', evalType: 'comparison' },
    { id: 'fin_bva_exp', domain: 'Finance', category: 'Budget vs Actual', question: 'Budget vs actual expenses', req: ['revenue', 'order_date'], grain: 'month', vis: 'groupedBar', sql: '...', evalType: 'comparison' },
    { id: 'fin_variance', domain: 'Finance', category: 'Budget vs Actual', question: 'Budget variance by department', req: ['revenue', 'customer_name'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },

    { id: 'fin_current_ratio', domain: 'Finance', category: 'Financial Ratios', question: 'Current ratio', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'fin_debt_equity', domain: 'Finance', category: 'Financial Ratios', question: 'Debt-to-equity ratio trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'fin_roe', domain: 'Finance', category: 'Financial Ratios', question: 'Return on equity', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'fin_op_margin', domain: 'Finance', category: 'Financial Ratios', question: 'Operating margin trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'curvedLine', sql: '...', evalType: 'trend' },
    { id: 'fin_ar_aging', domain: 'Finance', category: 'Financial Ratios', question: 'Accounts receivable aging', req: ['revenue', 'product_name'], grain: 'any', vis: 'bar', sql: '...', evalType: 'ranking' },
    { id: 'fin_rev_run', domain: 'Finance', category: 'Revenue & Income', question: 'Revenue running total (YTD)', req: ['revenue', 'order_date'], grain: 'month', vis: 'area', sql: '...', evalType: 'trend' },
    { id: 'fin_rev_top', domain: 'Finance', category: 'Revenue & Income', question: 'Top 10 revenue sources', req: ['product_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'fin_cost_trend', domain: 'Finance', category: 'Expenses & Costs', question: 'Cost trend (quarterly)', req: ['revenue', 'order_date'], grain: 'quarter', vis: 'line', sql: '...', evalType: 'trend' },
];

// ╔══════════════════════════════════════════════════════════════════╗
// ║  HEALTHCARE DOMAIN — 30 Questions                              ║
// ╚══════════════════════════════════════════════════════════════════╝
const HEALTHCARE_QUESTIONS: QuestionTemplate[] = [
    { id: 'hc_patient_vol', domain: 'Healthcare', category: 'Patient Volume', question: 'Total patients this month', req: ['customer_id', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'hc_vol_trend', domain: 'Healthcare', category: 'Patient Volume', question: 'Patient volume trend (monthly)', req: ['customer_id', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'hc_vol_dept', domain: 'Healthcare', category: 'Patient Volume', question: 'Patients by department', req: ['customer_name', 'customer_id'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hc_admissions', domain: 'Healthcare', category: 'Patient Volume', question: 'Daily admissions', req: ['customer_id', 'order_date'], grain: 'day', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'hc_vol_vs_lm', domain: 'Healthcare', category: 'Patient Volume', question: 'Patient volume vs last month', req: ['customer_id', 'order_date'], grain: 'month', vis: 'groupedBar', sql: '...', evalType: 'comparison' },
    { id: 'hc_vol_type', domain: 'Healthcare', category: 'Patient Volume', question: 'Inpatient vs outpatient split', req: ['category', 'customer_id'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },

    { id: 'hc_avg_los', domain: 'Healthcare', category: 'Length of Stay', question: 'Average length of stay', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'hc_los_trend', domain: 'Healthcare', category: 'Length of Stay', question: 'Length of stay trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'hc_los_dept', domain: 'Healthcare', category: 'Length of Stay', question: 'LOS by department', req: ['customer_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hc_los_diag', domain: 'Healthcare', category: 'Length of Stay', question: 'LOS by diagnosis group', req: ['product_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },

    { id: 'hc_readmit', domain: 'Healthcare', category: 'Readmissions & Outcomes', question: 'Readmission rate', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'hc_readmit_trend', domain: 'Healthcare', category: 'Readmissions & Outcomes', question: 'Readmission trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'hc_mortality', domain: 'Healthcare', category: 'Readmissions & Outcomes', question: 'Mortality rate by unit', req: ['customer_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hc_outcomes', domain: 'Healthcare', category: 'Readmissions & Outcomes', question: 'Patient outcome distribution', req: ['category', 'customer_id'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },
    { id: 'hc_satisfaction', domain: 'Healthcare', category: 'Readmissions & Outcomes', question: 'Patient satisfaction score', req: ['rating', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },

    { id: 'hc_cost_patient', domain: 'Healthcare', category: 'Cost & Billing', question: 'Average cost per patient', req: ['revenue', 'customer_id'], grain: 'any', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'hc_cost_trend', domain: 'Healthcare', category: 'Cost & Billing', question: 'Cost trend (monthly)', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'hc_cost_dept', domain: 'Healthcare', category: 'Cost & Billing', question: 'Cost by department', req: ['customer_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hc_rev_month', domain: 'Healthcare', category: 'Cost & Billing', question: 'Total billing this month', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'hc_rev_payer', domain: 'Healthcare', category: 'Cost & Billing', question: 'Revenue by payer type', req: ['revenue', 'product_name'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },

    { id: 'hc_bed_occ', domain: 'Healthcare', category: 'Staff & Capacity', question: 'Bed occupancy rate', req: ['revenue', 'order_date'], grain: 'day', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'hc_staff_ratio', domain: 'Healthcare', category: 'Staff & Capacity', question: 'Staff-to-patient ratio', req: ['revenue', 'customer_name'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hc_wait_time', domain: 'Healthcare', category: 'Staff & Capacity', question: 'Average wait time', req: ['revenue', 'order_date'], grain: 'day', vis: 'line', sql: '...', evalType: 'trend' },

    { id: 'hc_quality', domain: 'Healthcare', category: 'Clinical Quality', question: 'Clinical quality score', req: ['rating', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'hc_infection', domain: 'Healthcare', category: 'Clinical Quality', question: 'Infection rate trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'hc_compliance', domain: 'Healthcare', category: 'Clinical Quality', question: 'Compliance rate by unit', req: ['customer_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hc_diag_dist', domain: 'Healthcare', category: 'Patient Volume', question: 'Top diagnosis groups', req: ['product_name', 'customer_id'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'hc_er_volume', domain: 'Healthcare', category: 'Patient Volume', question: 'ER visit volume trend', req: ['customer_id', 'order_date'], grain: 'day', vis: 'area', sql: '...', evalType: 'trend' },
    { id: 'hc_rev_trend', domain: 'Healthcare', category: 'Cost & Billing', question: 'Revenue trend (quarterly)', req: ['revenue', 'order_date'], grain: 'quarter', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'hc_vol_daily', domain: 'Healthcare', category: 'Patient Volume', question: 'Patients today', req: ['customer_id', 'order_date'], grain: 'day', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
];

// ╔══════════════════════════════════════════════════════════════════╗
// ║  INVENTORY DOMAIN — 30 Questions                               ║
// ╚══════════════════════════════════════════════════════════════════╝
const INVENTORY_QUESTIONS: QuestionTemplate[] = [
    { id: 'inv_total_stock', domain: 'Inventory', category: 'Stock Levels', question: 'Total stock on hand', req: ['quantity', 'order_date'], grain: 'day', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'inv_stock_cat', domain: 'Inventory', category: 'Stock Levels', question: 'Stock by category', req: ['quantity', 'product_name'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'inv_low_stock', domain: 'Inventory', category: 'Stock Levels', question: 'Items below reorder point', req: ['product_name', 'quantity'], grain: 'any', vis: 'table', sql: '...', evalType: 'ranking' },
    { id: 'inv_stock_trend', domain: 'Inventory', category: 'Stock Levels', question: 'Stock level trend', req: ['quantity', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'inv_stock_val', domain: 'Inventory', category: 'Stock Levels', question: 'Total inventory value', req: ['revenue', 'order_date'], grain: 'day', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'inv_out_of_stock', domain: 'Inventory', category: 'Stock Levels', question: 'Out-of-stock items', req: ['product_name', 'quantity'], grain: 'any', vis: 'table', sql: '...', evalType: 'ranking' },

    { id: 'inv_turnover', domain: 'Inventory', category: 'Inventory Turnover', question: 'Inventory turnover rate', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'inv_turn_cat', domain: 'Inventory', category: 'Inventory Turnover', question: 'Turnover by category', req: ['product_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'inv_turn_trend', domain: 'Inventory', category: 'Inventory Turnover', question: 'Turnover trend (monthly)', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'inv_days_on_hand', domain: 'Inventory', category: 'Inventory Turnover', question: 'Average days on hand', req: ['revenue', 'product_name'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'inv_slow_moving', domain: 'Inventory', category: 'Inventory Turnover', question: 'Slow-moving items', req: ['product_name', 'quantity'], grain: 'any', vis: 'table', sql: '...', evalType: 'ranking' },

    { id: 'inv_aging', domain: 'Inventory', category: 'Aging & Obsolescence', question: 'Inventory aging breakdown', req: ['revenue', 'category'], grain: 'any', vis: 'bar', sql: '...', evalType: 'ranking' },
    { id: 'inv_expired', domain: 'Inventory', category: 'Aging & Obsolescence', question: 'Expired/obsolete stock value', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'inv_shrinkage', domain: 'Inventory', category: 'Aging & Obsolescence', question: 'Shrinkage rate trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'inv_write_off', domain: 'Inventory', category: 'Aging & Obsolescence', question: 'Write-off value this month', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },

    { id: 'inv_reorder', domain: 'Inventory', category: 'Reorder & Replenishment', question: 'Items due for reorder', req: ['product_name', 'quantity'], grain: 'any', vis: 'table', sql: '...', evalType: 'ranking' },
    { id: 'inv_lead_time', domain: 'Inventory', category: 'Reorder & Replenishment', question: 'Average lead time by supplier', req: ['customer_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'inv_order_freq', domain: 'Inventory', category: 'Reorder & Replenishment', question: 'Reorder frequency by category', req: ['product_name', 'order_id', 'order_date'], grain: 'any', vis: 'bar', sql: '...', evalType: 'ranking' },

    { id: 'inv_wh_perf', domain: 'Inventory', category: 'Warehouse Performance', question: 'Stock by warehouse', req: ['region', 'quantity'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'inv_wh_util', domain: 'Inventory', category: 'Warehouse Performance', question: 'Warehouse utilization', req: ['region', 'revenue'], grain: 'any', vis: 'bar', sql: '...', evalType: 'ranking' },
    { id: 'inv_receiving', domain: 'Inventory', category: 'Warehouse Performance', question: 'Receiving volume trend', req: ['quantity', 'order_date'], grain: 'month', vis: 'area', sql: '...', evalType: 'trend' },
    { id: 'inv_accuracy', domain: 'Inventory', category: 'Warehouse Performance', question: 'Inventory accuracy rate', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },

    { id: 'inv_demand_trend', domain: 'Inventory', category: 'Demand Forecasting', question: 'Demand trend (monthly)', req: ['quantity', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'inv_seasonality', domain: 'Inventory', category: 'Demand Forecasting', question: 'Seasonal demand pattern', req: ['quantity', 'order_date'], grain: 'month', vis: 'curvedLine', sql: '...', evalType: 'trend' },
    { id: 'inv_top_movers', domain: 'Inventory', category: 'Demand Forecasting', question: 'Top 10 fastest-moving items', req: ['product_name', 'quantity'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'inv_demand_cat', domain: 'Inventory', category: 'Demand Forecasting', question: 'Demand by category', req: ['product_name', 'quantity'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },
    { id: 'inv_stock_vs_lm', domain: 'Inventory', category: 'Stock Levels', question: 'Stock vs last month', req: ['quantity', 'order_date'], grain: 'month', vis: 'groupedBar', sql: '...', evalType: 'comparison' },
    { id: 'inv_fill_rate', domain: 'Inventory', category: 'Warehouse Performance', question: 'Order fill rate', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'inv_cost_share', domain: 'Inventory', category: 'Stock Levels', question: 'Inventory cost distribution', req: ['revenue', 'product_name'], grain: 'any', vis: 'treemap', sql: '...', evalType: 'percentOfTotal' },
    { id: 'inv_daily_mv', domain: 'Inventory', category: 'Warehouse Performance', question: 'Daily stock movements', req: ['quantity', 'order_date'], grain: 'day', vis: 'bar', sql: '...', evalType: 'trend' },
];

// ╔══════════════════════════════════════════════════════════════════╗
// ║  SaaS DOMAIN — 30 Questions                                    ║
// ╚══════════════════════════════════════════════════════════════════╝
const SAAS_QUESTIONS: QuestionTemplate[] = [
    { id: 'saas_mrr', domain: 'SaaS', category: 'MRR & ARR', question: 'Current MRR', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'saas_arr', domain: 'SaaS', category: 'MRR & ARR', question: 'Annual recurring revenue', req: ['revenue', 'order_date'], grain: 'year', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'saas_mrr_trend', domain: 'SaaS', category: 'MRR & ARR', question: 'MRR growth trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'saas_mrr_vs_lm', domain: 'SaaS', category: 'MRR & ARR', question: 'MRR vs last month', req: ['revenue', 'order_date'], grain: 'month', vis: 'groupedBar', sql: '...', evalType: 'comparison' },
    { id: 'saas_mrr_plan', domain: 'SaaS', category: 'MRR & ARR', question: 'MRR by plan type', req: ['revenue', 'product_name'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },
    { id: 'saas_net_new', domain: 'SaaS', category: 'MRR & ARR', question: 'Net new MRR this month', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },

    { id: 'saas_churn', domain: 'SaaS', category: 'Churn & Retention', question: 'Monthly churn rate', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'saas_churn_trend', domain: 'SaaS', category: 'Churn & Retention', question: 'Churn rate trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'saas_retention', domain: 'SaaS', category: 'Churn & Retention', question: 'Net revenue retention', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'saas_churn_plan', domain: 'SaaS', category: 'Churn & Retention', question: 'Churn by plan type', req: ['product_name', 'customer_id'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'saas_churn_reason', domain: 'SaaS', category: 'Churn & Retention', question: 'Churn reasons breakdown', req: ['category', 'customer_id'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },

    { id: 'saas_ltv', domain: 'SaaS', category: 'Customer Lifetime Value', question: 'Average customer LTV', req: ['revenue', 'customer_id'], grain: 'any', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'saas_ltv_plan', domain: 'SaaS', category: 'Customer Lifetime Value', question: 'LTV by plan type', req: ['product_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'saas_cac', domain: 'SaaS', category: 'Customer Lifetime Value', question: 'Customer acquisition cost', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'saas_ltv_cac', domain: 'SaaS', category: 'Customer Lifetime Value', question: 'LTV:CAC ratio trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },

    { id: 'saas_expansion', domain: 'SaaS', category: 'Expansion Revenue', question: 'Expansion revenue this month', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'saas_upsell', domain: 'SaaS', category: 'Expansion Revenue', question: 'Upsell revenue by plan', req: ['product_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'saas_expansion_tr', domain: 'SaaS', category: 'Expansion Revenue', question: 'Expansion revenue trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'area', sql: '...', evalType: 'trend' },
    { id: 'saas_downgrade', domain: 'SaaS', category: 'Expansion Revenue', question: 'Downgrade rate trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },

    { id: 'saas_active', domain: 'SaaS', category: 'Usage & Engagement', question: 'Active users this month', req: ['customer_id', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'saas_dau', domain: 'SaaS', category: 'Usage & Engagement', question: 'DAU trend', req: ['customer_id', 'order_date'], grain: 'day', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'saas_engagement', domain: 'SaaS', category: 'Usage & Engagement', question: 'Feature usage breakdown', req: ['product_name', 'customer_id'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'saas_usage_plan', domain: 'SaaS', category: 'Usage & Engagement', question: 'Usage by plan tier', req: ['product_name', 'revenue'], grain: 'any', vis: 'bar', sql: '...', evalType: 'ranking' },

    { id: 'saas_pipeline', domain: 'SaaS', category: 'Pipeline & Conversion', question: 'Pipeline value', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'saas_conv_rate', domain: 'SaaS', category: 'Pipeline & Conversion', question: 'Trial-to-paid conversion rate', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'saas_trial_trend', domain: 'SaaS', category: 'Pipeline & Conversion', question: 'Trial signups trend', req: ['customer_id', 'order_date'], grain: 'month', vis: 'area', sql: '...', evalType: 'trend' },
    { id: 'saas_top_cust', domain: 'SaaS', category: 'Customer Lifetime Value', question: 'Top 10 customers by revenue', req: ['customer_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'saas_rev_geo', domain: 'SaaS', category: 'MRR & ARR', question: 'Revenue by region', req: ['region', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'saas_arpu', domain: 'SaaS', category: 'MRR & ARR', question: 'Average revenue per user', req: ['revenue', 'customer_id'], grain: 'any', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'saas_cust_trend', domain: 'SaaS', category: 'Pipeline & Conversion', question: 'Customer count trend', req: ['customer_id', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
];

// ╔══════════════════════════════════════════════════════════════════╗
// ║  EDUCATION DOMAIN — 30 Questions                               ║
// ╚══════════════════════════════════════════════════════════════════╝
const EDUCATION_QUESTIONS: QuestionTemplate[] = [
    { id: 'edu_enrollment', domain: 'Education', category: 'Enrollment & Admissions', question: 'Total enrollment', req: ['customer_id', 'order_date'], grain: 'any', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'edu_enroll_trend', domain: 'Education', category: 'Enrollment & Admissions', question: 'Enrollment trend', req: ['customer_id', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'edu_enroll_prog', domain: 'Education', category: 'Enrollment & Admissions', question: 'Enrollment by program', req: ['product_name', 'customer_id'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'edu_new_students', domain: 'Education', category: 'Enrollment & Admissions', question: 'New admissions this month', req: ['customer_id', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'edu_accept_rate', domain: 'Education', category: 'Enrollment & Admissions', question: 'Acceptance rate trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'edu_enroll_share', domain: 'Education', category: 'Enrollment & Admissions', question: 'Enrollment share by department', req: ['product_name', 'customer_id'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },

    { id: 'edu_avg_grade', domain: 'Education', category: 'Academic Performance', question: 'Average grade/GPA', req: ['revenue', 'order_date'], grain: 'any', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'edu_grade_dist', domain: 'Education', category: 'Academic Performance', question: 'Grade distribution', req: ['category', 'customer_id'], grain: 'any', vis: 'bar', sql: '...', evalType: 'ranking' },
    { id: 'edu_grade_prog', domain: 'Education', category: 'Academic Performance', question: 'Performance by program', req: ['product_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'edu_pass_rate', domain: 'Education', category: 'Academic Performance', question: 'Pass rate trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'edu_grade_trend', domain: 'Education', category: 'Academic Performance', question: 'GPA trend (semester)', req: ['revenue', 'order_date'], grain: 'quarter', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'edu_top_students', domain: 'Education', category: 'Academic Performance', question: 'Top performing students', req: ['customer_name', 'revenue'], grain: 'any', vis: 'table', sql: '...', evalType: 'ranking' },

    { id: 'edu_attendance', domain: 'Education', category: 'Attendance & Punctuality', question: 'Average attendance rate', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'edu_att_trend', domain: 'Education', category: 'Attendance & Punctuality', question: 'Attendance trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'edu_att_prog', domain: 'Education', category: 'Attendance & Punctuality', question: 'Attendance by program', req: ['product_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'edu_chronic_abs', domain: 'Education', category: 'Attendance & Punctuality', question: 'Chronic absenteeism rate', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },

    { id: 'edu_grad_rate', domain: 'Education', category: 'Graduation & Retention', question: 'Graduation rate', req: ['revenue', 'order_date'], grain: 'year', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'edu_dropout', domain: 'Education', category: 'Graduation & Retention', question: 'Dropout rate by program', req: ['product_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'edu_retention', domain: 'Education', category: 'Graduation & Retention', question: 'Student retention rate', req: ['revenue', 'order_date'], grain: 'year', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'edu_completion', domain: 'Education', category: 'Graduation & Retention', question: 'Course completion rate', req: ['product_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },

    { id: 'edu_faculty', domain: 'Education', category: 'Faculty & Staff', question: 'Student-to-faculty ratio', req: ['revenue', 'customer_name'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'edu_faculty_cnt', domain: 'Education', category: 'Faculty & Staff', question: 'Faculty count by department', req: ['customer_name', 'customer_id'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'edu_staff_trend', domain: 'Education', category: 'Faculty & Staff', question: 'Staff headcount trend', req: ['customer_id', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },

    { id: 'edu_fin_aid', domain: 'Education', category: 'Financial Aid', question: 'Total financial aid disbursed', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'edu_aid_type', domain: 'Education', category: 'Financial Aid', question: 'Aid by type (grants/loans/scholarships)', req: ['category', 'revenue'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },
    { id: 'edu_aid_trend', domain: 'Education', category: 'Financial Aid', question: 'Financial aid trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'area', sql: '...', evalType: 'trend' },
    { id: 'edu_tuition', domain: 'Education', category: 'Financial Aid', question: 'Tuition revenue this month', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'edu_enroll_vs_lm', domain: 'Education', category: 'Enrollment & Admissions', question: 'Enrollment vs last month', req: ['customer_id', 'order_date'], grain: 'month', vis: 'groupedBar', sql: '...', evalType: 'comparison' },
    { id: 'edu_sat_score', domain: 'Education', category: 'Academic Performance', question: 'Student satisfaction score', req: ['rating', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'edu_course_pop', domain: 'Education', category: 'Enrollment & Admissions', question: 'Most popular courses', req: ['product_name', 'customer_id'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
];

// ╔══════════════════════════════════════════════════════════════════╗
// ║  MARKETING DOMAIN — 30 Questions                               ║
// ╚══════════════════════════════════════════════════════════════════╝
const MARKETING_QUESTIONS: QuestionTemplate[] = [
    { id: 'mkt_impressions', domain: 'Marketing', category: 'Campaign Performance', question: 'Total impressions this month', req: ['quantity', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'mkt_clicks', domain: 'Marketing', category: 'Campaign Performance', question: 'Total clicks this month', req: ['quantity', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'mkt_ctr', domain: 'Marketing', category: 'Campaign Performance', question: 'Click-through rate trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'mkt_camp_perf', domain: 'Marketing', category: 'Campaign Performance', question: 'Campaign performance comparison', req: ['product_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'mkt_spend', domain: 'Marketing', category: 'Campaign Performance', question: 'Total ad spend this month', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'mkt_spend_trend', domain: 'Marketing', category: 'Campaign Performance', question: 'Ad spend trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },

    { id: 'mkt_conv_rate', domain: 'Marketing', category: 'Conversion & Funnel', question: 'Conversion rate', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'mkt_conv_trend', domain: 'Marketing', category: 'Conversion & Funnel', question: 'Conversion rate trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'mkt_funnel', domain: 'Marketing', category: 'Conversion & Funnel', question: 'Funnel stage distribution', req: ['category', 'customer_id'], grain: 'any', vis: 'bar', sql: '...', evalType: 'ranking' },
    { id: 'mkt_conv_chan', domain: 'Marketing', category: 'Conversion & Funnel', question: 'Conversion by channel', req: ['source', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'mkt_bounce', domain: 'Marketing', category: 'Conversion & Funnel', question: 'Bounce rate trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },

    { id: 'mkt_cac', domain: 'Marketing', category: 'Customer Acquisition', question: 'Customer acquisition cost', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'mkt_cac_trend', domain: 'Marketing', category: 'Customer Acquisition', question: 'CAC trend (monthly)', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'mkt_cac_channel', domain: 'Marketing', category: 'Customer Acquisition', question: 'CAC by channel', req: ['source', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'mkt_new_leads', domain: 'Marketing', category: 'Customer Acquisition', question: 'New leads this month', req: ['customer_id', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'mkt_lead_trend', domain: 'Marketing', category: 'Customer Acquisition', question: 'Lead generation trend', req: ['customer_id', 'order_date'], grain: 'month', vis: 'area', sql: '...', evalType: 'trend' },

    { id: 'mkt_chan_rev', domain: 'Marketing', category: 'Channel Analysis', question: 'Revenue by channel', req: ['source', 'revenue'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },
    { id: 'mkt_chan_comp', domain: 'Marketing', category: 'Channel Analysis', question: 'Channel performance comparison', req: ['source', 'revenue', 'order_date'], grain: 'month', vis: 'groupedBar', sql: '...', evalType: 'comparison' },
    { id: 'mkt_organic', domain: 'Marketing', category: 'Channel Analysis', question: 'Organic vs paid traffic', req: ['source', 'customer_id'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },
    { id: 'mkt_social', domain: 'Marketing', category: 'Channel Analysis', question: 'Social media performance', req: ['source', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },

    { id: 'mkt_engagement', domain: 'Marketing', category: 'Content & Engagement', question: 'Engagement rate trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'mkt_content_perf', domain: 'Marketing', category: 'Content & Engagement', question: 'Top content by engagement', req: ['product_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'mkt_email_open', domain: 'Marketing', category: 'Content & Engagement', question: 'Email open rate trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'mkt_email_click', domain: 'Marketing', category: 'Content & Engagement', question: 'Email click rate by campaign', req: ['product_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },

    { id: 'mkt_roas', domain: 'Marketing', category: 'ROI & ROAS', question: 'Return on ad spend', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'mkt_roas_trend', domain: 'Marketing', category: 'ROI & ROAS', question: 'ROAS trend', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: '...', evalType: 'trend' },
    { id: 'mkt_roas_camp', domain: 'Marketing', category: 'ROI & ROAS', question: 'ROAS by campaign', req: ['product_name', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: '...', evalType: 'ranking' },
    { id: 'mkt_roi', domain: 'Marketing', category: 'ROI & ROAS', question: 'Marketing ROI', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: '...', evalType: 'kpi' },
    { id: 'mkt_spend_share', domain: 'Marketing', category: 'Campaign Performance', question: 'Spend distribution by channel', req: ['source', 'revenue'], grain: 'any', vis: 'doughnut', sql: '...', evalType: 'percentOfTotal' },
    { id: 'mkt_camp_vs_lm', domain: 'Marketing', category: 'Campaign Performance', question: 'Campaign spend vs last month', req: ['revenue', 'order_date'], grain: 'month', vis: 'groupedBar', sql: '...', evalType: 'comparison' },
];

// ═══════════════════════════════════════════════════════════════════
// EXPORT: All domain questions combined
// ═══════════════════════════════════════════════════════════════════
export const DOMAIN_QUESTIONS: QuestionTemplate[] = [
    ...HR_QUESTIONS,
    ...FINANCE_QUESTIONS,
    ...HEALTHCARE_QUESTIONS,
    ...INVENTORY_QUESTIONS,
    ...SAAS_QUESTIONS,
    ...EDUCATION_QUESTIONS,
    ...MARKETING_QUESTIONS,
];

/**
 * Get questions filtered by domain.
 * Returns domain-specific + universal questions.
 */
export function getQuestionsForDomain(domain: string): QuestionTemplate[] {
    return DOMAIN_QUESTIONS.filter(q => q.domain === domain);
}

/**
 * Get all supported domain names.
 */
export function getSupportedDomains(): string[] {
    return [...new Set(DOMAIN_QUESTIONS.map(q => q.domain).filter(Boolean))] as string[];
}
