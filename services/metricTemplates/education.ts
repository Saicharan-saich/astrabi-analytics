import { MetricTemplate, IN, m } from './types';
const I = 'education';
export const EDUCATION_TEMPLATES: MetricTemplate[] = [
  // ── Student Performance ──
  m(I,'performance','pass_rate','Pass Rate %','Students passing.','✅','passed/total×100',[IN.a('Students Passed','a'),IN.a('Total Students','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'performance','fail_rate','Fail Rate %','Students failing.','❌','failed/total×100',[IN.a('Students Failed','a'),IN.a('Total Students','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'performance','avg_grade_score','Weighted Grade Score','Weighted average grade.','📊','(score×credits)/credits',[IN.a('Total Score×Credits','a'),IN.a('Total Credits','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'performance','grade_improvement','Grade Improvement','Current vs previous score.','📈','current − previous',[IN.a('Current Score','a'),IN.a('Previous Score','b')],({a,b})=>a-b,'number','AVG'),
  m(I,'performance','grade_improvement_pct','Grade Improvement %','% change in score.','📈','(curr−prev)/prev×100',[IN.a('Current Score','a'),IN.a('Previous Score','b')],({a,b})=>b===0?null:((a-b)/b)*100,'percent','AVG','non_additive'),
  m(I,'performance','completion_rate','Course Completion %','Courses completed.','🏁','completed/enrolled×100',[IN.a('Completed','a'),IN.a('Enrolled','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'performance','credit_hours_earned','Credit Hours Earned','Credits × pass flag.','📝','credits × passed',[IN.a('Credit Hours','a'),IN.a('Pass Flag (1/0)','b')],({a,b})=>a*b,'number'),
  m(I,'performance','gpa_points','GPA Points','Grade points earned.','🎓','grade_point × credits',[IN.a('Grade Points','a'),IN.a('Credits','b')],({a,b})=>a*b,'number'),
  m(I,'performance','assessment_score_pct','Assessment Score %','Score as percentage.','📋','score/max×100',[IN.a('Score','a'),IN.a('Max Score','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'performance','assignment_completion','Assignment Completion %','Submitted assignments.','📄','submitted/assigned×100',[IN.a('Submitted','a'),IN.a('Assigned','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),

  // ── Enrollment & Retention ──
  m(I,'enrollment','enrollment_rate','Enrollment Rate %','Admitted who enrolled.','📊','enrolled/admitted×100',[IN.a('Enrolled','a'),IN.a('Admitted','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'enrollment','acceptance_rate','Acceptance Rate %','Applications accepted.','✅','accepted/applied×100',[IN.a('Accepted','a'),IN.a('Applied','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'enrollment','yield_rate','Yield Rate %','Accepted who enrolled.','🎯','enrolled/accepted×100',[IN.a('Enrolled','a'),IN.a('Accepted','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'enrollment','retention_rate','Retention Rate %','Students returning.','🔒','retained/start×100',[IN.a('Retained','a'),IN.a('Start Enrollment','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'enrollment','dropout_rate','Dropout Rate %','Students leaving.','🚪','dropouts/enrolled×100',[IN.a('Dropouts','a'),IN.a('Enrolled','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'enrollment','graduation_rate','Graduation Rate %','Students graduating.','🎓','graduates/cohort×100',[IN.a('Graduates','a'),IN.a('Cohort Size','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'enrollment','transfer_rate','Transfer Rate %','Students transferring.','🔄','transfers/enrolled×100',[IN.a('Transfers','a'),IN.a('Enrolled','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'enrollment','enrollment_growth','Enrollment Growth %','Year-over-year growth.','📈','(curr−prev)/prev×100',[IN.a('Current Enrollment','a'),IN.a('Previous Enrollment','b')],({a,b})=>b===0?null:((a-b)/b)*100,'percent','AVG','non_additive'),

  // ── Financial ──
  m(I,'financial','cost_per_student','Cost Per Student','Total cost per student.','💸','total_cost / students',[IN.a('Total Cost','a'),IN.a('Students','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'financial','revenue_per_student','Revenue Per Student','Revenue per head.','💰','revenue / students',[IN.rev(),IN.a('Students','b')],({revenue,b})=>b===0?null:revenue/b,'currency','AVG','non_additive'),
  m(I,'financial','tuition_revenue','Tuition Revenue','Tuition collected.','💵','tuition × enrolled',[IN.a('Tuition Fee','a'),IN.a('Enrolled','b')],({a,b})=>a*b,'currency'),
  m(I,'financial','scholarship_cost','Scholarship Cost','Total scholarships.','🎓','scholarship × recipients',[IN.a('Avg Scholarship','a'),IN.a('Recipients','b')],({a,b})=>a*b,'currency'),
  m(I,'financial','net_tuition','Net Tuition','Tuition minus financial aid.','💳','tuition − aid',[IN.a('Gross Tuition','a'),IN.a('Financial Aid','b')],({a,b})=>a-(b||0),'currency'),
  m(I,'financial','endowment_per_student','Endowment/Student','Endowment per student.','🏦','endowment / students',[IN.a('Endowment Value','a'),IN.a('Students','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'financial','aid_coverage','Aid Coverage %','Aid as % of tuition.','📊','aid/tuition×100',[IN.a('Financial Aid','a'),IN.a('Tuition','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'financial','operating_margin','Operating Margin %','Revenue minus expenses.','📉','(rev−exp)/rev×100',[IN.rev(),IN.a('Expenses','b')],({revenue,b})=>revenue===0?null:((revenue-b)/revenue)*100,'percent','AVG','non_additive'),

  // ── Faculty & Staff ──
  m(I,'faculty','student_faculty_ratio','Student:Faculty Ratio','Students per faculty.','👨‍🏫','students / faculty',[IN.a('Students','a'),IN.a('Faculty','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'faculty','class_size_avg','Avg Class Size','Students per section.','📚','students / sections',[IN.a('Total Students','a'),IN.a('Sections','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'faculty','faculty_cost_per_student','Faculty Cost/Student','Faculty expense per head.','💸','faculty_cost / students',[IN.a('Faculty Cost','a'),IN.a('Students','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'faculty','adjunct_ratio','Adjunct Ratio %','Part-time faculty.','👥','adjunct/total×100',[IN.a('Adjunct Faculty','a'),IN.a('Total Faculty','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'faculty','faculty_load','Faculty Teaching Load','Credit hours per faculty.','📊','credit_hours / faculty',[IN.a('Total Credit Hours','a'),IN.a('Faculty','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'faculty','staff_per_student','Staff:Student Ratio','Support staff ratio.','🧑‍💼','staff / students',[IN.a('Staff','a'),IN.a('Students','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),

  // ── Facilities & Resources ──
  m(I,'facilities','space_utilization','Space Utilization %','Rooms used.','🏫','used/available×100',[IN.a('Used Rooms','a'),IN.a('Available Rooms','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'facilities','cost_per_sq_ft','Cost Per Sq Ft','Facility cost density.','🏢','facility_cost / sqft',[IN.a('Facility Cost','a'),IN.a('Square Footage','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'facilities','technology_spend_per_student','Tech Spend/Student','IT investment per head.','💻','tech_spend / students',[IN.a('Technology Spend','a'),IN.a('Students','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'facilities','library_usage_rate','Library Usage %','Active library users.','📖','active/total×100',[IN.a('Active Users','a'),IN.a('Total Students','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'facilities','device_ratio','Device:Student Ratio','Devices per student.','📱','devices / students',[IN.a('Devices','a'),IN.a('Students','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),

  // ── Online / Distance Learning ──
  m(I,'online','online_enrollment_pct','Online Enrollment %','Online vs total.','🌐','online/total×100',[IN.a('Online Students','a'),IN.a('Total Students','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'online','course_completion_online','Online Completion %','Online course completion.','✅','completed/enrolled×100',[IN.a('Completed','a'),IN.a('Enrolled Online','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'online','engagement_score','Online Engagement Score','Logins × time weighted.','💡','logins × avg_minutes / 60',[IN.a('Logins','a'),IN.a('Avg Minutes/Session','b')],({a,b})=>a*b/60,'number','AVG','non_additive'),
  m(I,'online','content_coverage','Content Coverage %','Material accessed.','📚','accessed/available×100',[IN.a('Content Accessed','a'),IN.a('Total Content','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'online','forum_participation','Forum Participation %','Students posting.','💬','posters/enrolled×100',[IN.a('Active Posters','a'),IN.a('Enrolled','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),

  // ── Research ──
  m(I,'research','research_spend_per_faculty','Research $/Faculty','Research investment.','🔬','research_spend / faculty',[IN.a('Research Spend','a'),IN.a('Faculty','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'research','grant_success_rate','Grant Success %','Grants won.','🏆','won/applied×100',[IN.a('Grants Won','a'),IN.a('Grants Applied','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'research','publication_per_faculty','Publications/Faculty','Research output.','📄','publications / faculty',[IN.a('Publications','a'),IN.a('Faculty','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'research','citation_impact','Citation Impact','Citations per publication.','📑','citations / publications',[IN.a('Citations','a'),IN.a('Publications','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'research','research_revenue_ratio','Research Revenue %','Research as % of revenue.','💰','research_rev/total_rev×100',[IN.a('Research Revenue','a'),IN.rev('Total Revenue')],({a,revenue})=>revenue===0?null:(a/revenue)*100,'percent','AVG','non_additive'),
];
