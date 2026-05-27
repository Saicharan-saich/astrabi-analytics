import { MetricTemplate, IN, m } from './types';
const I = 'hr';
export const HR_TEMPLATES: MetricTemplate[] = [
  // ── Compensation ──
  m(I,'compensation','total_comp','Total Compensation','Base salary plus all benefits.','💰','salary + benefits',[IN.a('Base Salary','a'),IN.a('Benefits Value','b')],({a,b})=>a+b,'currency'),
  m(I,'compensation','hourly_rate','Hourly Rate','Hourly equivalent of salary.','⏰','salary / annual_hours',[IN.a('Annual Salary','a'),IN.a('Annual Work Hours','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'compensation','overtime_cost','Overtime Cost','Cost of overtime hours.','🕐','ot_hours × ot_rate',[IN.a('OT Hours','a'),IN.a('OT Rate','b')],({a,b})=>a*b,'currency'),
  m(I,'compensation','overtime_pct','Overtime %','OT hours as % of regular.','📊','ot/regular×100',[IN.a('OT Hours','a'),IN.a('Regular Hours','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'compensation','bonus_total','Total Bonus','Performance + retention bonus.','🎁','perf_bonus + ret_bonus',[IN.a('Performance Bonus','a'),IN.a('Retention Bonus','b')],({a,b})=>a+(b||0),'currency'),
  m(I,'compensation','comp_ratio','Compa-Ratio','Salary vs midpoint.','📐','salary/midpoint×100',[IN.a('Salary','a'),IN.a('Range Midpoint','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'compensation','pay_gap','Pay Gap','Difference in compensation.','⚖️','group_a − group_b',[IN.a('Group A Pay','a'),IN.a('Group B Pay','b')],({a,b})=>a-b,'currency','AVG'),
  m(I,'compensation','pay_gap_pct','Pay Gap %','% difference in pay.','📉','(a−b)/a×100',[IN.a('Higher Pay','a'),IN.a('Lower Pay','b')],({a,b})=>a===0?null:((a-b)/a)*100,'percent','AVG','non_additive'),
  m(I,'compensation','benefits_cost_ratio','Benefits Cost Ratio','Benefits as % of salary.','🏥','benefits/salary×100',[IN.a('Benefits Cost','a'),IN.a('Salary','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'compensation','total_labor_cost','Total Labor Cost','Salary + benefits + OT.','💸','salary + benefits + ot',[IN.a('Salary','a'),IN.a('Benefits','b'),IN.a('OT Cost','c')],({a,b,c})=>a+b+(c||0),'currency'),

  // ── Recruitment ──
  m(I,'recruitment','cost_per_hire','Cost Per Hire','Total recruitment cost per hire.','💼','total_cost / hires',[IN.a('Recruitment Cost','a'),IN.a('Number of Hires','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'recruitment','sourcing_cost','Sourcing Cost','Cost per sourced candidate.','🔍','source_spend / candidates',[IN.a('Sourcing Spend','a'),IN.a('Candidates Sourced','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'recruitment','offer_accept_rate','Offer Accept Rate %','% of offers accepted.','✅','accepted/offered×100',[IN.a('Offers Accepted','a'),IN.a('Offers Made','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'recruitment','time_to_fill_cost','Daily Vacancy Cost','Cost per day of open position.','📅','annual_salary / 365',[IN.a('Annual Salary','a')],({a})=>a/365,'currency','AVG','non_additive'),
  m(I,'recruitment','quality_of_hire','Quality of Hire Score','Weighted hiring quality.','⭐','(perf+retention)/2',[IN.a('Performance Score','a'),IN.a('Retention Score','b')],({a,b})=>(a+b)/2,'number','AVG','non_additive'),
  m(I,'recruitment','recruitment_yield','Recruitment Yield %','Hires from applications.','📊','hires/applications×100',[IN.a('Hires','a'),IN.a('Applications','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'recruitment','interview_to_offer','Interview-to-Offer %','Interviews that get offers.','🎯','offers/interviews×100',[IN.a('Offers','a'),IN.a('Interviews','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'recruitment','agency_fee','Agency Fee','Fee paid to recruitment agency.','🏢','salary × fee_pct/100',[IN.a('Placed Salary','a'),IN.a('Agency Fee %','b')],({a,b})=>a*(b||0)/100,'currency'),
  m(I,'recruitment','new_hire_cost','New Hire Total Cost','Salary + onboarding + equipment.','👔','salary + onboard + equip',[IN.a('Salary','a'),IN.a('Onboarding Cost','b'),IN.a('Equipment Cost','c')],({a,b,c})=>a+b+(c||0),'currency'),
  m(I,'recruitment','referral_bonus','Referral Bonus Cost','Cost of employee referral bonuses.','🤝','referrals × bonus_amount',[IN.a('Referrals','a'),IN.a('Bonus Per Referral','b')],({a,b})=>a*b,'currency'),

  // ── Attendance & Leave ──
  m(I,'attendance','absenteeism_rate','Absenteeism Rate %','Days absent as % of work days.','📋','absent/workdays×100',[IN.a('Days Absent','a'),IN.a('Total Work Days','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'attendance','absent_cost','Absenteeism Cost','Cost of absent days.','💸','absent_days × daily_rate',[IN.a('Days Absent','a'),IN.a('Daily Salary','b')],({a,b})=>a*b,'currency'),
  m(I,'attendance','leave_utilization','Leave Utilization %','Used leave vs available.','📅','used/available×100',[IN.a('Leave Used','a'),IN.a('Leave Available','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'attendance','leave_balance_value','Leave Balance Value','Dollar value of unused leave.','💵','remaining_days × daily_rate',[IN.a('Remaining Leave Days','a'),IN.a('Daily Rate','b')],({a,b})=>a*b,'currency'),
  m(I,'attendance','attendance_rate','Attendance Rate %','Attendance percentage.','✅','present/total×100',[IN.a('Days Present','a'),IN.a('Total Days','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),

  // ── Performance ──
  m(I,'performance','performance_score','Weighted Performance','Weighted average of metrics.','⭐','(skill×w1 + goals×w2)',[IN.a('Skill Score','a'),IN.a('Goal Score','b')],({a,b})=>(a+b)/2,'number','AVG','non_additive'),
  m(I,'performance','productivity_index','Productivity Index','Output per hour worked.','📈','output / hours',[IN.a('Output Units','a'),IN.hours('Hours Worked')],({a,hours})=>hours===0?null:a/hours,'number','AVG','non_additive'),
  m(I,'performance','revenue_per_employee','Revenue Per Employee','Revenue attributed per person.','💲','revenue / headcount',[IN.rev(),IN.a('Headcount','b')],({revenue,b})=>b===0?null:revenue/b,'currency','AVG','non_additive'),
  m(I,'performance','cost_per_employee','Cost Per Employee','Total cost per person.','💸','total_cost / headcount',[IN.a('Total Cost','a'),IN.a('Headcount','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'performance','training_roi','Training ROI %','Return on training investment.','🎓','(benefit−cost)/cost×100',[IN.a('Training Benefit','a'),IN.a('Training Cost','b')],({a,b})=>b===0?null:((a-b)/b)*100,'percent','AVG','non_additive'),

  // ── Turnover ──
  m(I,'turnover','turnover_rate','Turnover Rate %','Exits as % of headcount.','🚪','exits/headcount×100',[IN.a('Exits','a'),IN.a('Avg Headcount','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'turnover','retention_rate','Retention Rate %','Employees retained.','🔒','retained/start×100',[IN.a('Retained','a'),IN.a('Start Count','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'turnover','turnover_cost','Turnover Cost','Cost per departed employee.','💸','(recruit+train+lost_prod)',[IN.a('Recruitment Cost','a'),IN.a('Training Cost','b'),IN.a('Lost Productivity','c')],({a,b,c})=>a+b+(c||0),'currency'),
  m(I,'turnover','regrettable_turnover_pct','Regrettable Turnover %','High performers who left.','😢','regret_exits/total_exits×100',[IN.a('Regrettable Exits','a'),IN.a('Total Exits','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'turnover','new_hire_turnover','New Hire Turnover %','Exits within first year.','🆕','early_exits/new_hires×100',[IN.a('Early Exits','a'),IN.a('New Hires','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),

  // ── Diversity & Engagement ──
  m(I,'diversity','diversity_ratio','Diversity Ratio','Minority representation.','🌍','minority/total×100',[IN.a('Minority Count','a'),IN.a('Total Count','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'diversity','gender_pay_ratio','Gender Pay Ratio','Female to male pay ratio.','⚖️','female_pay/male_pay×100',[IN.a('Female Avg Pay','a'),IN.a('Male Avg Pay','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'diversity','engagement_index','Engagement Index','Weighted engagement score.','💡','(survey_score×response_rate/100)',[IN.a('Survey Score','a'),IN.a('Response Rate %','b')],({a,b})=>a*(b||100)/100,'number','AVG','non_additive'),
  m(I,'diversity','enps','Employee NPS','Net Promoter Score.','📊','promoters − detractors',[IN.a('Promoters %','a'),IN.a('Detractors %','b')],({a,b})=>a-b,'number','AVG','non_additive'),
  m(I,'diversity','span_of_control','Span of Control','Reports per manager.','👥','reports / managers',[IN.a('Direct Reports','a'),IN.a('Managers','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),

  // ── Training ──
  m(I,'training','training_hours_per_emp','Training Hours/Employee','Avg training investment.','📚','total_hours / headcount',[IN.hours('Total Training Hours'),IN.a('Headcount','b')],({hours,b})=>b===0?null:hours/b,'number','AVG','non_additive'),
  m(I,'training','training_cost_per_emp','Training Cost/Employee','Spend per employee.','💰','training_spend / headcount',[IN.a('Training Spend','a'),IN.a('Headcount','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'training','training_completion','Training Completion %','Completed vs assigned.','✅','completed/assigned×100',[IN.a('Completed','a'),IN.a('Assigned','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'training','skill_gap_score','Skill Gap Score','Required minus current skill.','📏','required − current',[IN.a('Required Level','a'),IN.a('Current Level','b')],({a,b})=>a-b,'number','AVG'),
  m(I,'training','cert_rate','Certification Rate %','Employees certified.','🏅','certified/total×100',[IN.a('Certified','a'),IN.a('Total Eligible','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),

  // ── Workforce Planning ──
  m(I,'planning','fte_equivalent','FTE Equivalent','Part-time to FTE conversion.','👤','hours / standard_hours',[IN.hours('Actual Hours'),IN.a('Standard FTE Hours','b')],({hours,b})=>b===0?null:hours/b,'number','SUM'),
  m(I,'planning','vacancy_rate','Vacancy Rate %','Open positions vs total.','🔓','open/total×100',[IN.a('Open Positions','a'),IN.a('Total Positions','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'planning','headcount_growth','Headcount Growth %','Period-over-period growth.','📈','(current−previous)/previous×100',[IN.a('Current HC','a'),IN.a('Previous HC','b')],({a,b})=>b===0?null:((a-b)/b)*100,'percent','AVG','non_additive'),
  m(I,'planning','labor_cost_ratio','Labor Cost %','Labor as % of revenue.','💼','labor/revenue×100',[IN.a('Labor Cost','a'),IN.rev()],({a,revenue})=>revenue===0?null:(a/revenue)*100,'percent','AVG','non_additive'),
  m(I,'planning','succession_coverage','Succession Coverage %','Roles with successors.','🔄','covered/critical×100',[IN.a('Covered Roles','a'),IN.a('Critical Roles','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
];
