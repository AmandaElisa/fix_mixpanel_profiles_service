export const REQUIRED_MIXPANEL_FIELDS = [
  "status",
  "plan",
  "endDate",
  "toleranceEndDate",
  "recurrence",
] as const;

export type RequiredMixpanelField = typeof REQUIRED_MIXPANEL_FIELDS[number];

/**
 * Map from Mixpanel field -> Mongo field
 * Ex. Mixpanel.endDate comes from Mongo.expireDate
 */
export const MIXPANEL_TO_MONGO_FIELD: Record<RequiredMixpanelField, string> = {
  status: "status",
  plan: "plan",
  endDate: "expireDate",
  toleranceEndDate: "toleranceDate",
  recurrence: "recurrence",
};
