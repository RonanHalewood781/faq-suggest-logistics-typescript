import { strict as assert } from "node:assert";
import { chooseFaqs } from "./logistics_faq_service.js";

const result = chooseFaqs({ query: "proof delivery" }, [
  { id: "a", question: "Where is my proof of delivery?", answer: "receipt", tags: ["proof"] },
  { id: "b", question: "How do I change an address?", answer: "address", tags: ["account"] }
]);
assert.deepEqual(result.map(item => item.id), ["a"]);
console.log("chooseFaqs decision test passed");
