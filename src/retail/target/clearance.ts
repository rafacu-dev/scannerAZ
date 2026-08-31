import { registerClearanceConnector } from "../clearance.js";
import { searchTargetClearance } from "./client.js";

registerClearanceConnector({
  retailer: "target",
  searchClearance: searchTargetClearance
});
