import type { SessionConfig } from "../src/domain";

/**
 * Canned answers for the scorer eval. Each question has a clearly weak, an
 * average and a strong answer, written by hand to be unambiguous to a human
 * reviewer. The eval checks the scorer orders them weak < average < strong
 * and how much its scores move across repeated runs.
 */

export type Level = "weak" | "average" | "strong";

export interface EvalQuestion {
  id: string;
  config: SessionConfig;
  question: string;
  answers: Record<Level, string>;
}

export const EVAL_QUESTIONS: EvalQuestion[] = [
  {
    id: "tech-cache",
    config: { role: "Backend Engineer", seniority: "mid", type: "technical" },
    question:
      "Our product page API is slow under load. How would you use caching to speed it up, and what can go wrong?",
    answers: {
      weak: "I would add Redis. Caching makes things faster so it should fix it.",
      average:
        "I'd put a Redis cache in front of the database for product reads, keyed by product id, with a TTL of a few minutes. On a miss we read the database and populate the cache. The risk is stale data, so when a product is updated I'd delete the key. We should also watch the hit rate.",
      strong:
        "First I'd confirm reads dominate and find the hot keys. Then a cache-aside layer in Redis keyed by product id and version, TTL around 5 minutes plus jitter so keys don't expire together. Writes go to the database and then invalidate the key; if stale-for-seconds is unacceptable for price, I'd keep price out of the cached blob. Failure modes: stampede on a hot key expiring, so I'd use request coalescing or a short lock; cache outage, so reads fall back to the DB with a circuit breaker and load shedding; and memory pressure, so LRU eviction and monitoring hit ratio and p99. A CDN layer for anonymous traffic would cut origin load further.",
    },
  },
  {
    id: "tech-index",
    config: { role: "Backend Engineer", seniority: "senior", type: "technical" },
    question:
      "A query filtering orders by customer_id and created_at is slow. How do you investigate and fix it?",
    answers: {
      weak: "Add an index on the table. Indexes make queries faster.",
      average:
        "I would run EXPLAIN to see if it does a full table scan. If so I'd add an index on customer_id and created_at. Then I'd check the query is faster. Too many indexes slow down writes, so I would not add more than needed.",
      strong:
        "I'd start with EXPLAIN ANALYZE on a production-like dataset to confirm a sequential scan or a poor index choice, and check the actual filter: equality on customer_id and a range on created_at. That suggests a composite index (customer_id, created_at), equality column first so the range is a contiguous slice; if we only select a few columns, INCLUDE them to get an index-only scan. I'd build it concurrently to avoid locking writes, compare before/after latency and rows examined, and watch write amplification and index size. If customers have wildly different order counts I'd also check stale statistics causing bad plans.",
    },
  },
  {
    id: "behav-conflict",
    config: { role: "Software Engineer", seniority: "mid", type: "behavioral" },
    question: "Tell me about a time you disagreed with a teammate on a technical decision.",
    answers: {
      weak: "I don't really have conflicts. I get along with everyone and we usually agree.",
      average:
        "On one project a teammate wanted to use a new framework and I thought it was risky. We talked about it in a meeting and decided to use the existing one. It worked out fine and we shipped on time.",
      strong:
        "Last year my teammate proposed moving our notification service to a new message queue two weeks before a launch. I owned the launch timeline, so I was worried. Instead of arguing in the channel I asked for 30 minutes, and we listed the risks together. I built a small load test that showed the current queue handled 3x our launch traffic, so we agreed to ship on the existing queue and schedule the migration for the following sprint. Launch went out with zero incidents, and the migration later cut our queue costs by about 20%. What I learned is to turn opinions into a quick experiment early; I now propose that by default.",
    },
  },
  {
    id: "design-shortener",
    config: { role: "Backend Engineer", seniority: "senior", type: "system_design" },
    question: "Design a URL shortener. Start wherever you think is most important.",
    answers: {
      weak: "I would use a database to store the URLs and a server to redirect. Maybe use the cloud so it scales.",
      average:
        "Users submit a long URL and get a short code. I'd generate a random 7-character code, store code and URL in a database, and on GET look up the code and redirect with a 301. To scale I'd add a cache for popular codes and run several app servers behind a load balancer.",
      strong:
        "Let me pin requirements: create and redirect, custom aliases optional, around 100M new links a month and maybe 10B redirects, so it's read-heavy at roughly 4k redirects per second average with spikes. Redirect latency matters most. Codes: base62 of 7 chars gives 3.5 trillion, so I'd use a pre-allocated ID range per writer encoded in base62 to avoid collision checks, versus random codes that need a uniqueness check. Storage is a simple key-value table partitioned by code. Redirects are served from an edge cache and CDN; I'd use 302 instead of 301 if we need click analytics, accepting more origin traffic, and push click events to a queue for async aggregation. Failure handling: the cache falls back to replicated KV, and ID allocators are leased so a crash just wastes a range.",
    },
  },
];
