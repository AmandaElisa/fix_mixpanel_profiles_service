import 'dotenv/config';

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  MIXPANEL_PROJECT_ID: must('MIXPANEL_PROJECT_ID'),
  MIXPANEL_SERVICE_USERNAME: must('MIXPANEL_SERVICE_USERNAME'),
  MIXPANEL_SERVICE_SECRET: must('MIXPANEL_SERVICE_SECRET'),
  MIXPANEL_TOKEN: must('MIXPANEL_TOKEN'),
  MONGODB_URI: must('MONGODB_URI'),
  MONGODB_DB: must('MONGODB_DB'),
  MONGODB_COLLECTION: must('MONGODB_COLLECTION'),
  DISTINCT_EQUALS_AID: (process.env.DISTINCT_EQUALS_AID ?? 'true').toLowerCase() === 'true',
  DRY_RUN: (process.env.DRY_RUN ?? '0') === '1',
  FORCE_UPDATE_IF_DIFFERENT: (process.env.FORCE_UPDATE_IF_DIFFERENT ?? 'false').toLowerCase() === 'true',
  AID_PROP_NAME: process.env.AID_PROP_NAME ?? 'Store Id (aid)',
  FALLBACK_AID_EQUALS_DISTINCT: (process.env.FALLBACK_AID_EQUALS_DISTINCT ?? 'false').toLowerCase() === 'true',

};
