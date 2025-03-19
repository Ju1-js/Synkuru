const { addonBuilder } = require("stremio-addon-sdk");
const { getNameFromCinemetaId } = require("./lib/cinemeta");
const { getCatalog } = require("./lib/anilist");
const { getAnilistId } = require("./lib/id-mapping");
const { handleWatchedEpisode } = require("./lib/anilist");

const CATALOGS = [
  // { id: "RELEASES", type: "anime", name: "New Releases" }, // Will need to be per RSS feed eventually - NOT IMPLEMENTED YET
  { id: "SYN_CURRENT", type: "anime", name: "Continue Watching" },
  { id: "SYN_WATCHING", type: "anime", name: "Watching List" },
  { id: "SYN_REPEATING", type: "anime", name: "Repeating" },
  { id: "SYN_SEQUELS", type: "anime", name: "Sequels You Missed" },
  { id: "SYN_STORIES", type: "anime", name: "Stories You Missed" },
  { id: "SYN_PLANNING", type: "anime", name: "Planning List" },
  { id: "SYN_PAUSED", type: "anime", name: "Paused" },
  { id: "SYN_DROPPED", type: "anime", name: "Dropped" },
  { id: "SYN_COMPLETED", type: "anime", name: "Completed" },
  { id: "SYN_POPULAR", type: "anime", name: "Popular This Season" },
  { id: "SYN_TRENDING", type: "anime", name: "Trending Now" },
  { id: "SYN_ALLPOPULAR", type: "anime", name: "All Time Popular" },
  { id: "SYN_ROMANCE", type: "anime", name: "Romance" },
  { id: "SYN_ACTION", type: "anime", name: "Action" },
  { id: "SYN_ADVENTURE", type: "anime", name: "Adventure" },
  { id: "SYN_FANTASY", type: "anime", name: "Fantasy" },
  { id: "SYN_COMEDY", type: "anime", name: "Comedy" },
];

// Docs: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md
const builder = new addonBuilder({
  id: "com.Ju1-js.Synkuru",
  version: "0.0.1",
  name: "Synkuru",
  description:
    "Synkuru interfaces with Anilist and allows custom AnimeTosho RSS feeds.",
  background:
    "https://raw.githubusercontent.com/Ju1-js/synkuru/main/addon-background.png",
  logo: "https://raw.githubusercontent.com/Ju1-js/synkuru/main/addon-logo.png",
  resources: ["catalog",/* "meta", */"subtitles"],
  types: ["anime", "movie", "series"],
  catalogs: CATALOGS,
  idPrefixes: ["anilist", "tt", "kitsu"],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  config: [
    {
      key: "token",
      type: "text",
      title: "Anilist token",
    },
  ],
});

builder.defineSubtitlesHandler(async (args) => {
  const { token, enableSearch, preAddedOnly } = args.config;
  let anilistId = "0";
  let animeName = "";
  let episode = "0";

  if (args.id.startsWith("kitsu")) {
    const [_, id, currEp] = args.id.split(":");
    anilistId = await getAnilistId(id, "kitsu");
    episode = args.type === "movie" ? "1" : currEp;
  } else {
    let [id, seasonName, currEp] = args.id.split(":");
    if (args.type === "movie") {
      anilistId = await getAnilistId(id, "imdb");
      episode = "1";
    } else if (enableSearch) {
      const season = parseInt(seasonName);
      animeName = await getNameFromCinemetaId(id, args.type);
      if (animeName && season > 1) {
        animeName += ` ${season}`;
      }
      episode = currEp;
    }
  }

  if ((animeName || anilistId) && episode) {
    try {
      await handleWatchedEpisode(
        animeName,
        parseInt(anilistId),
        parseInt(episode),
        preAddedOnly,
        token
      );
    } catch (err) {
      console.error(err);
    }
  }
  return Promise.resolve({ subtitles: [] });
});

builder.defineCatalogHandler(async (args) => {
  const { token } = args.config;
  const catalog = CATALOGS.find((c) => c.id === args.id);

  if (!catalog) return { metas: [] };

  try {
    const metas = await getCatalog(args.id, token);
    return { metas };
  } catch (error) {
    console.error(`Catalog ${args.id} error:`, error);
    return { metas: [] };
  }
});

module.exports = builder.getInterface();
