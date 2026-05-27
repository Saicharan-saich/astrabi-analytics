import { MetricTemplate, IN, m } from './types';
const I = 'marketing';
export const MARKETING_TEMPLATES: MetricTemplate[] = [
  // ── Campaign Performance ──
  m(I,'campaign','cost_per_click','Cost Per Click','CPC for paid campaigns.','🖱️','spend / clicks',[IN.a('Ad Spend','a'),IN.a('Clicks','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'campaign','cost_per_impression','Cost Per 1K Impressions','CPM rate.','👁️','spend/impressions×1000',[IN.a('Ad Spend','a'),IN.a('Impressions','b')],({a,b})=>b===0?null:(a/b)*1000,'currency','AVG','non_additive'),
  m(I,'campaign','click_through_rate','Click-Through Rate %','Clicks per impression.','📊','clicks/impressions×100',[IN.a('Clicks','a'),IN.a('Impressions','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'campaign','conversion_rate','Conversion Rate %','Conversions per click.','🎯','conversions/clicks×100',[IN.a('Conversions','a'),IN.a('Clicks','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'campaign','cost_per_conversion','Cost Per Conversion','CPA for campaigns.','💲','spend / conversions',[IN.a('Ad Spend','a'),IN.a('Conversions','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'campaign','roas','ROAS','Return on ad spend.','📈','revenue / spend',[IN.rev('Campaign Revenue'),IN.a('Ad Spend','b')],({revenue,b})=>b===0?null:revenue/b,'number','AVG','non_additive'),
  m(I,'campaign','roi_pct','Campaign ROI %','Return on investment.','💰','(rev−spend)/spend×100',[IN.rev('Revenue'),IN.a('Total Spend','b')],({revenue,b})=>b===0?null:((revenue-b)/b)*100,'percent','AVG','non_additive'),
  m(I,'campaign','revenue_per_click','Revenue Per Click','RPC metric.','💵','revenue / clicks',[IN.rev(),IN.a('Clicks','b')],({revenue,b})=>b===0?null:revenue/b,'currency','AVG','non_additive'),
  m(I,'campaign','ad_frequency','Ad Frequency','Impressions per user.','🔄','impressions / reach',[IN.a('Impressions','a'),IN.a('Reach','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'campaign','effective_cpm','Effective CPM','Actual cost per 1K.','💳','total_cost/impressions×1000',[IN.a('Total Cost','a'),IN.a('Impressions','b')],({a,b})=>b===0?null:(a/b)*1000,'currency','AVG','non_additive'),

  // ── Lead Generation ──
  m(I,'leads','cost_per_lead','Cost Per Lead','CPL metric.','🎣','spend / leads',[IN.a('Marketing Spend','a'),IN.a('Leads Generated','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'leads','lead_conversion_rate','Lead Conversion %','Leads to customers.','🔄','customers/leads×100',[IN.a('New Customers','a'),IN.a('Total Leads','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'leads','mql_to_sql','MQL to SQL %','Marketing to sales qualified.','📊','sql/mql×100',[IN.a('SQLs','a'),IN.a('MQLs','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'leads','sql_to_close','SQL to Close %','Sales qualified to deal.','🏆','deals/sql×100',[IN.a('Closed Deals','a'),IN.a('SQLs','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'leads','lead_value','Lead Value','Expected value per lead.','💎','avg_deal × conv_rate/100',[IN.a('Avg Deal Size','a'),IN.a('Conversion Rate %','b')],({a,b})=>a*(b||0)/100,'currency','AVG','non_additive'),
  m(I,'leads','pipeline_velocity','Pipeline Velocity','Speed of pipeline.','🚀','leads × rate × value / cycle',[IN.a('Leads','a'),IN.a('Win Rate %','b'),IN.a('Avg Deal','c')],({a,b,c})=>a*(b/100)*c,'currency'),
  m(I,'leads','lead_score_value','Scored Lead Value','Lead score × deal size.','⭐','score × deal_size / 100',[IN.a('Lead Score','a'),IN.a('Potential Deal','b')],({a,b})=>a*b/100,'currency','AVG','non_additive'),
  m(I,'leads','lead_response_cost','Cost Per Response','Cost per lead response.','📩','spend / responses',[IN.a('Campaign Spend','a'),IN.a('Responses','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),

  // ── Content & Engagement ──
  m(I,'content','engagement_rate','Engagement Rate %','Interactions per reach.','💬','engagements/reach×100',[IN.a('Engagements','a'),IN.a('Reach','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'content','share_rate','Share Rate %','Shares per view.','📤','shares/views×100',[IN.a('Shares','a'),IN.a('Views','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'content','cost_per_engagement','Cost Per Engagement','CPE metric.','💲','spend / engagements',[IN.a('Spend','a'),IN.a('Engagements','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'content','video_completion_rate','Video Completion %','Videos watched fully.','🎬','completed/started×100',[IN.a('Completed Views','a'),IN.a('Started Views','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'content','bounce_rate_cost','Bounce Cost','Spend wasted on bounces.','📉','spend × bounce_rate/100',[IN.a('Page Spend','a'),IN.a('Bounce Rate %','b')],({a,b})=>a*(b||0)/100,'currency'),
  m(I,'content','content_roi','Content ROI %','Return per content piece.','📝','(value−cost)/cost×100',[IN.a('Content Value','a'),IN.a('Content Cost','b')],({a,b})=>b===0?null:((a-b)/b)*100,'percent','AVG','non_additive'),

  // ── Email Marketing ──
  m(I,'email','email_open_rate','Email Open Rate %','Opens per sent.','📧','opens/sent×100',[IN.a('Opens','a'),IN.a('Emails Sent','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'email','email_click_rate','Email Click Rate %','Clicks per open.','🖱️','clicks/opens×100',[IN.a('Clicks','a'),IN.a('Opens','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'email','email_conversion_rate','Email Conv Rate %','Conversions per click.','🎯','conversions/clicks×100',[IN.a('Conversions','a'),IN.a('Clicks','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'email','unsubscribe_rate','Unsubscribe Rate %','Unsubs per sent.','📉','unsubs/sent×100',[IN.a('Unsubscribes','a'),IN.a('Emails Sent','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'email','revenue_per_email','Revenue Per Email','Revenue per email sent.','💵','revenue / sent',[IN.rev(),IN.a('Emails Sent','b')],({revenue,b})=>b===0?null:revenue/b,'currency','AVG','non_additive'),
  m(I,'email','email_roi','Email ROI %','Email campaign return.','💰','(rev−cost)/cost×100',[IN.rev(),IN.cost('Email Cost')],({revenue,cost})=>cost===0?null:((revenue-cost)/cost)*100,'percent','AVG','non_additive'),
  m(I,'email','list_growth_rate','List Growth %','Net subscriber growth.','📈','(new−unsubs)/total×100',[IN.a('New Subs','a'),IN.a('Unsubs','b'),IN.a('Total List','c')],({a,b,c})=>c===0?null:((a-b)/c)*100,'percent','AVG','non_additive'),
  m(I,'email','delivery_rate','Delivery Rate %','Delivered vs sent.','✅','delivered/sent×100',[IN.a('Delivered','a'),IN.a('Sent','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),

  // ── Customer Acquisition ──
  m(I,'acquisition','cac','Customer Acq Cost','Total CAC.','💸','total_spend / new_customers',[IN.a('Total Marketing Spend','a'),IN.a('New Customers','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'acquisition','ltv_to_cac','LTV:CAC Ratio','Lifetime value vs acq cost.','📊','ltv / cac',[IN.a('Customer LTV','a'),IN.a('CAC','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'acquisition','payback_period','CAC Payback (months)','Months to recover CAC.','📅','cac / monthly_revenue',[IN.a('CAC','a'),IN.a('Monthly Revenue/Customer','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'acquisition','cac_ratio','CAC Ratio %','CAC as % of first deal.','📐','cac/first_deal×100',[IN.a('CAC','a'),IN.a('First Deal Value','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'acquisition','blended_cpc','Blended CPC','All-channel CPC.','💳','total_spend / total_clicks',[IN.a('All Channel Spend','a'),IN.a('All Clicks','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),

  // ── Social Media ──
  m(I,'social','follower_growth_rate','Follower Growth %','Net follower change.','📈','(new−lost)/total×100',[IN.a('New Followers','a'),IN.a('Unfollows','b'),IN.a('Total Followers','c')],({a,b,c})=>c===0?null:((a-b)/c)*100,'percent','AVG','non_additive'),
  m(I,'social','social_engagement_rate','Social Engagement %','Engagement per follower.','💬','engagements/followers×100',[IN.a('Engagements','a'),IN.a('Followers','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'social','social_roi','Social Media ROI %','Return from social.','💰','(value−spend)/spend×100',[IN.a('Social Revenue','a'),IN.a('Social Spend','b')],({a,b})=>b===0?null:((a-b)/b)*100,'percent','AVG','non_additive'),
  m(I,'social','cost_per_follower','Cost Per Follower','Acquisition cost.','👤','spend / new_followers',[IN.a('Social Spend','a'),IN.a('New Followers','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'social','viral_coefficient','Viral Coefficient','Referrals per user.','🔗','referrals / users',[IN.a('Referrals','a'),IN.a('Users','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),

  // ── SEO & Website ──
  m(I,'seo','organic_ctr','Organic CTR %','Search click-through.','🔍','clicks/impressions×100',[IN.a('Organic Clicks','a'),IN.a('Search Impressions','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'seo','revenue_per_visit','Revenue Per Visit','Site revenue per visit.','💲','revenue / visits',[IN.rev(),IN.a('Site Visits','b')],({revenue,b})=>b===0?null:revenue/b,'currency','AVG','non_additive'),
  m(I,'seo','cost_per_visit','Cost Per Visit','Marketing cost per visit.','💸','spend / visits',[IN.a('Marketing Spend','a'),IN.a('Visits','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'seo','page_value','Page Value','Revenue per pageview.','📄','revenue / pageviews',[IN.rev(),IN.a('Pageviews','b')],({revenue,b})=>b===0?null:revenue/b,'currency','AVG','non_additive'),
];
