/** COMBOBOX: a custom dropdown (role=combobox, e.g. react-select on Greenhouse). Its options exist only once opened. */
export const FIELD_KINDS = ["TEXT", "TEXTAREA", "DROPDOWN", "COMBOBOX", "RADIO", "CHECKBOX", "MULTI_SELECT", "FILE_UPLOAD", "DATE", "NUMBER"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export const FIELD_CLASSES = ["KNOWN_SAFE", "KNOWN_REQUIRES_REVIEW", "UNKNOWN", "SENSITIVE", "LEGAL_OR_ELIGIBILITY", "CAPTCHA", "OTP", "FILE_UPLOAD"] as const;
export type FieldClass = (typeof FIELD_CLASSES)[number];

/** A form control as seen in the DOM. Produced by formDetector (browser) or test fixtures. */
export interface DetectedField {
  key: string; // stable within one page load: data-aja-id or radio group name
  kind: FieldKind;
  label: string;
  name: string | null;
  id: string | null;
  inputType: string | null;
  autocomplete: string | null;
  placeholder: string | null;
  required: boolean;
  options: string[]; // select/radio/checkbox-group option labels
  accept: string | null;
  multiple: boolean;
  currentValue: string;
  visible: boolean;
  /** data-aja-id of the enclosing <form>, or "noform". Used to isolate the application form from newsletter/search forms. */
  formKey: string;
}

export interface DetectedButton {
  key: string;
  text: string;
  tag: "button" | "input" | "a";
  type: string | null; // submit | button | reset | null
  inForm: boolean;
  href: string | null;
  visible: boolean;
  /** data-aja-id of the enclosing <form>, or "noform". Used to isolate the application form from newsletter/search forms. */
  formKey: string;
}

export interface PageSignals {
  url: string;
  title: string;
  bodyText: string;
  captchaDetected: boolean;
  captchaEvidence: string | null;
  /** A CAPTCHA widget exists but is not shown (invisible/dormant); it may challenge on submit. */
  captchaDormant: string | null;
  otpDetected: boolean;
  loginDetected: boolean;
  passwordFieldPresent: boolean;
  /** "Verify it's you"-style identity/security checks (not a CAPTCHA widget). */
  securityCheckDetected: boolean;
  /** Any request for money: fee text, card/UPI/bank fields, a visible payment-gateway frame. Always a hard stop. */
  paymentDetected: boolean;
  paymentEvidence: string | null;
}
