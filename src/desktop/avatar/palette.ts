export const MAUS_COLORS = {
  green: "#009957",
  blue: "#377FE6",
  red: "#D94B52",
  orange: "#E78531",
  purple: "#8057C8",
  cyan: "#0EA5C6",
  pink: "#D84F8B",
  yellow: "#D8A729",
  teal: "#01A492",
  coral: "#E5634E",
  silver: "#A8ADB4",
  chrome: "#B3BAC4",
} ;


export const CHROME_GRADIENT: [string, string, string] = ["#F1F4F7", "#AEB8C3", "#66717E"];
export const CHROME_EYES = "#1E2833";


export type MausColor = keyof typeof MAUS_COLORS;
export type MausState = import('./CursorAvatar').CursorState;
export type MausMotion = "none" | "arrive" | "switch" | "customize" | "alert" | "thinking" | "working" | "launch" | "success" | "celebrate" | "blink" | "surprise" | "failure";
