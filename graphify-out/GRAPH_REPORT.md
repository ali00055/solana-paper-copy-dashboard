# Graph Report - solana-paper-copy-dashboard  (2026-10-25)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 408 nodes · 994 edges · 19 communities
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d82f0ad7`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18

## God Nodes (most connected - your core abstractions)
1. `server` - 42 edges
2. `apiOracleToken()` - 27 edges
3. `clamp()` - 25 edges
4. `apiResearch()` - 21 edges
5. `main()` - 19 edges
6. `processSignature()` - 18 edges
7. `apiSocialRadar()` - 18 edges
8. `apiOracleDiscover()` - 15 edges
9. `fetchJsonLoose()` - 14 edges
10. `apiNansenSmart()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `apiSocialRadar()` --indirect_call--> `looksSolanaAddress()`  [INFERRED]
  server.mjs → server.mjs  _Bridges community 1 → community 17_
- `apiNansenSmart()` --indirect_call--> `normalizeNansenSmartTrade()`  [INFERRED]
  server.mjs → server.mjs  _Bridges community 11 → community 6_
- `apiOracleToken()` --calls--> `oracleSourceNotes()`  [EXTRACTED]
  server.mjs → server.mjs  _Bridges community 1 → community 16_
- `apiOracleToken()` --calls--> `readEvents()`  [EXTRACTED]
  server.mjs → server.mjs  _Bridges community 1 → community 6_
- `apiOracleToken()` --calls--> `readJson()`  [EXTRACTED]
  server.mjs → server.mjs  _Bridges community 1 → community 5_

## Import Cycles
- None detected.

## Communities (19 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.07
Nodes (72): acquireBotLock(), addDiscoveredRelated(), appendEvent(), applyDiscoveredRelated(), applyRiskRules(), BOT_LOCK_PATH, closePosition(), CONFIG_PATH (+64 more)

### Community 1 - "Community 1"
Cohesion: 0.11
Nodes (36): ammCrashSimulation(), apiOracleToken(), bestSolanaPair(), birdeyeKey(), birdeyeTokenTrades(), buildResearchSignals(), clamp(), cleanSearchText() (+28 more)

### Community 2 - "Community 2"
Cohesion: 0.09
Nodes (33): ageHours(), candidateWallets, clusters, earlyBuyers(), FUNDER_LOOKBACK_SIGNATURES, fundingSource(), getJson(), insiderLikeWallets (+25 more)

### Community 3 - "Community 3"
Cohesion: 0.12
Nodes (20): children, ensurePersistentFile(), filesToPersist, jsonCount(), lineCount(), pathExists(), prepareDataDir(), restoreRicherSeed() (+12 more)

### Community 4 - "Community 4"
Cohesion: 0.14
Nodes (28): addControlWallet(), appendChatMessage(), applySettingsPatch(), batchWalletMode(), cleanWalletAddress(), clearStateCache(), closePaperPositionAt(), getBotStatus() (+20 more)

### Community 5 - "Community 5"
Cohesion: 0.12
Nodes (28): apiResearch(), apiWalletDetail(), apiWalletHunter(), arkhamSearchUrl(), buildHunterRows(), buildLiveHunterPreview(), cieloKey(), cieloWalletPnl() (+20 more)

### Community 6 - "Community 6"
Cohesion: 0.10
Nodes (23): apiState(), CONTROL_SETTING_FIELDS, firstValue(), getTokenPriceTry(), gmgnMarketRow(), gmgnShort(), gmgnTokenQuality(), gmgnTradeRow() (+15 more)

### Community 7 - "Community 7"
Cohesion: 0.17
Nodes (21): apiGmgnMarket(), apiGmgnSetup(), apiGmgnStatus(), apiGmgnToken(), apiGmgnTrack(), escapeEnvMultiline(), gmgnCliReady(), gmgnCliScriptPath() (+13 more)

### Community 8 - "Community 8"
Cohesion: 0.20
Nodes (17): analyzed, analyzeWallet(), buyerCandidates, buyerMap, earlyBuyersForToken(), excludedAddresses, getJson(), keyString() (+9 more)

### Community 9 - "Community 9"
Cohesion: 0.23
Nodes (15): analyzed, analyzeWallet(), candidates, earlyBuyersForToken(), excluded, getJson(), keyString(), map (+7 more)

### Community 10 - "Community 10"
Cohesion: 0.26
Nodes (14): analyzed, boostedAndMovingTokens(), candidates, earlyBuyers(), getJson(), keyString(), ranked, rpc() (+6 more)

### Community 11 - "Community 11"
Cohesion: 0.17
Nodes (15): alienMetricLab(), apiNansenSmart(), apiSuperAlpha(), compactReason(), edgeGrade(), edgeMode(), eventDedupKey(), isBaseAsset() (+7 more)

### Community 12 - "Community 12"
Cohesion: 0.18
Nodes (12): cachedApiState(), chatPageHtml(), controlPageHtml(), gmgnAgentPageHtml(), moonshotPageHtml(), oraclePageHtml(), pageHtml(), readBodyJson() (+4 more)

### Community 13 - "Community 13"
Cohesion: 0.20
Nodes (9): name, private, scripts, dashboard, start, start:all, status, type (+1 more)

### Community 14 - "Community 14"
Cohesion: 0.20
Nodes (9): key, value, services, autoDeploy, envVars, name, plan, runtime (+1 more)

### Community 15 - "Community 15"
Cohesion: 0.22
Nodes (10): addTrendScore(), alphaDecision(), alphaGrade(), alphaVoteRows(), apiAlphaCouncil(), apiTrendMap(), chainDisplayName(), finalizeTrendRows() (+2 more)

### Community 16 - "Community 16"
Cohesion: 0.22
Nodes (10): apiOracleDiscover(), execFileAsync, fetchDexPairsForMints(), maybeAutoFreeAlphaScan(), oracleSourceNotes(), parseJsonBuffer(), readJsonAnyEncoding(), readOracleWatchlist() (+2 more)

### Community 17 - "Community 17"
Cohesion: 0.22
Nodes (10): apiSocialRadar(), defaultSocialAccounts(), extractSocialEvents(), extractTokenMentions(), fetchXJson(), redditSocialPosts(), scoreSocialEvent(), socialRadarConfig() (+2 more)

### Community 18 - "Community 18"
Cohesion: 0.33
Nodes (6): apiOracleOpportunity(), countBy(), explainBlocker(), opportunityFromDiscovery(), opportunityFromSignal(), opportunityFromSocial()

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `server` connect `Community 12` to `Community 1`, `Community 4`, `Community 5`, `Community 6`, `Community 7`, `Community 11`, `Community 15`, `Community 16`, `Community 17`, `Community 18`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.07343987823439878 - nodes in this community are weakly interconnected._
- **Why does `apiOracleToken()` connect `Community 1` to `Community 16`, `Community 12`, `Community 5`, `Community 6`?**
  _High betweenness centrality (0.002) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.10952380952380952 - nodes in this community are weakly interconnected._
- **Why does `clamp()` connect `Community 1` to `Community 5`, `Community 6`, `Community 11`, `Community 15`, `Community 17`, `Community 18`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09411764705882353 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.12169312169312169 - nodes in this community are weakly interconnected._