// Imported first by every entry point, so that anything reading a setting reads
// it under its current name whichever name it was given (env-names.js).
import { adoptLegacyNames } from "./env-names.js";

adoptLegacyNames(process.env);
