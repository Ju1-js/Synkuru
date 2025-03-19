const fetch = require("node-fetch").default;
const Bottleneck = require("bottleneck").default;

const limiter = new Bottleneck({
  maxConcurrent: 5,
  reservoir: 30,
  reservoirRefreshAmount: 30,
  reservoirRefreshInterval: 60 * 1000,
  minTime: 100,
});

limiter.on("error", (error) => {
  console.error("Bottleneck error:", error);
});

let rateLimitPromise = null;
limiter.on("failed", async (error, jobInfo) => {
  if (error.response && error.response.status === 429) {
    const retryAfter = Number(error.response.headers.get("retry-after")) || 60;
    // Wait for the retry period.
    rateLimitPromise = new Promise((resolve) =>
      setTimeout(resolve, retryAfter * 1000)
    );
    await rateLimitPromise;
    // Clear rateLimitPromise so that subsequent requests can proceed.
    rateLimitPromise = null;
    return jobInfo.retryCount < 3 ? retryAfter * 1000 : null;
  }
  throw error;
});

const date = new Date();
const currentSeason = ["WINTER", "SPRING", "SUMMER", "FALL"][
  Math.floor((date.getMonth() / 12) * 4) % 4
];
const currentYear = date.getFullYear();

// In-memory cache with in-flight promise deduplication.
const cache = new Map();
function getCacheKey(query, variables) {
  return JSON.stringify({ query, variables });
}

function getCachedResult(query, variables, fetchFn) {
  // console.log(query);
  const key = getCacheKey(query, variables);
  if (cache.has(key)) {
    // console.log("Hit cache for query.");
    const { expiry, promise } = cache.get(key);
    if (expiry > Date.now()) {
      return promise;
    }
    cache.delete(key);
  }
  const promise = fetchFn()
    .then((data) => {
      // Save resolved promise with a 10-minute TTL.
      cache.set(key, {
        promise: Promise.resolve(data),
        expiry: Date.now() + 10 * 60 * 1000,
      });
      return data;
    })
    .catch((err) => {
      // Remove failed requests from cache.
      cache.delete(key);
      throw err;
    });
  // Cache the in-flight promise with the same TTL.
  cache.set(key, { promise, expiry: Date.now() + 10 * 60 * 1000 });
  return promise;
}

// Wrap the GraphQL request in the limiter scheduler.
async function makeGraphQLRequest(query, variables, token) {
  // console.log("Making request for query.");
  return limiter.schedule(async () => {
    const endpoint = "https://graphql.anilist.co";
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const options = {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    };

    if (rateLimitPromise) {
      await rateLimitPromise;
    }

    const response = await fetch(endpoint, options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(response.statusText + (text ? `: ${text}` : ""));
    }
    const data = await response.json();
    if (data.errors) {
      throw new Error(data.errors.map((e) => e.message).join(", "));
    }
    return data;
  });
}

async function getViewer(token) {
  const query = `query {
    Viewer { id }
  }`;
  const data = await getCachedResult(query, {}, () =>
    makeGraphQLRequest(query, {}, token)
  );
  return data.data.Viewer;
}

async function getUserLists(token) {
  const query = `query($userId: Int) {
    MediaListCollection(userId: $userId, type: ANIME, forceSingleCompletedList: true) {
      lists {
        status
        entries {
          media {
            id
            format
            title { userPreferred }
            coverImage { extraLarge }
            description
            genres
            averageScore
            relations {
              edges {
                relationType
                node { id }
              }
            }
          }
        }
      }
    }
  }`;
  const user = await getViewer(token);
  if (!user) return [];
  const variables = { userId: user.id };
  const data = await getCachedResult(query, variables, () =>
    makeGraphQLRequest(query, variables, token)
  );
  const lists = data.data.MediaListCollection.lists;
  return lists && lists.length ? lists : [];
}

async function getAnilistEntry(name, token) {
  const variables = { search: name, perPage: 1 };
  const query = `query($search: String, $perPage: Int) {
    Page(perPage: $perPage, page: 1) {
      media(type: ANIME, search: $search) {
        id
        format
        title { userPreferred }
        coverImage { extraLarge }
        description
        genres
        averageScore
      }
    }
  }`;
  const data = await getCachedResult(query, variables, () =>
    makeGraphQLRequest(query, variables, token)
  );
  return data.data.Page.media[0];
}

async function getAnilistEntryById(id, token) {
  const variables = { mediaId: id };
  const query = `query($mediaId: Int) {
    MediaList(mediaId: $mediaId) {
      progress
      status
      media {
        episodes
        format
      }
    }
  }`;
  const data = await getCachedResult(query, variables, () =>
    makeGraphQLRequest(query, variables, token)
  );
  return data.data.MediaList;
}

async function updateAnilist(id, currentEpisode, preAddedOnly, token) {
  const entry = await getAnilistEntryById(id, token);
  if (preAddedOnly && !entry) return;
  const currentProgress = entry?.progress || 0;
  if (currentProgress >= currentEpisode) return;

  const variables = {
    mediaId: id,
    status: entry?.status,
    progress: currentEpisode,
  };
  if (currentEpisode === entry?.media.episodes) {
    variables.status = "COMPLETED";
  }
  const mutation = `mutation($mediaId: Int, $status: MediaListStatus, $progress: Int) {
    SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress) { id }
  }`;
  await makeGraphQLRequest(mutation, variables, token);
}

async function getCatalog(catalogType, token) {
  const user = await getViewer(token);
  if (!user) return [];
  // console.log("Fetching catalog for user:", user.id);

  let variables = {};
  let query = "";
  catalogType = catalogType.replace(/^SYN_/, "");
  // console.log(catalogType);
  switch (catalogType) {
    case "CURRENT":
      variables = {
        status: ["CURRENT", "REPEATING"],
        sort: "UPDATED_TIME_DESC",
      };
      break;
    case "WATCHING":
      variables = { status: ["CURRENT"], sort: "UPDATED_TIME_DESC" };
      break;
    case "PLANNING":
      const lists = await getUserLists(token);
      const planningIds = lists
        .find((list) => list.status === "PLANNING")
        .entries.flatMap((entry) => entry.media.id);
      variables = {
        id_in: planningIds,
        status_in: ["FINISHED", "RELEASING"],
        sort: "POPULARITY_DESC",
      };
      break;
    case "PAUSED":
      variables = { status: ["PAUSED"], sort: "UPDATED_TIME_DESC" };
      break;
    case "DROPPED":
      variables = { status: ["DROPPED"], sort: "UPDATED_TIME_DESC" };
      break;
    case "COMPLETED":
      variables = { status: ["COMPLETED"], sort: "UPDATED_TIME_DESC" };
      break;
    case "REPEATING":
      variables = { status: ["REPEATING"], sort: "UPDATED_TIME_DESC" };
      break;
    case "SEQUELS": {
      const lists = await getUserLists(token);
      const completedList = lists.find((list) => list.status === "COMPLETED");
      const excludeIds = lists
        .filter((list) =>
          ["CURRENT", "REPEATING", "COMPLETED", "DROPPED", "PAUSED"].includes(
            list.status
          )
        )
        .flatMap((list) => list.entries.map((entry) => entry.media.id));
      const sequelIds = completedList.entries
        .flatMap((entry) =>
          entry.media.relations.edges
            .filter((edge) => edge.relationType === "SEQUEL")
            .map((edge) => edge.node.id)
        )
        .filter((id) => !excludeIds.includes(id));
      variables = {
        id_in: sequelIds,
        status_in: ["FINISHED", "RELEASING"],
        sort: "POPULARITY_DESC",
      };
      break;
    }
    case "STORIES": {
      const lists = await getUserLists(token);
      const completedList = lists.find((list) => list.status === "COMPLETED");
      const excludeIds = lists
        .filter((list) =>
          ["CURRENT", "REPEATING", "COMPLETED", "DROPPED", "PAUSED"].includes(
            list.status
          )
        )
        .flatMap((list) => list.entries.map((entry) => entry.media.id));
      const storyIds = completedList.entries
        .flatMap((entry) =>
          entry.media.relations.edges
            .filter(
              (edge) =>
                !["SEQUEL", "CHARACTER", "OTHER"].includes(edge.relationType)
            )
            .map((edge) => edge.node.id)
        )
        .filter((id) => !excludeIds.includes(id));
      variables = {
        id_in: storyIds,
        status_in: ["FINISHED", "RELEASING"],
        sort: "POPULARITY_DESC",
      };
      break;
    }
    case "POPULAR": {
      variables = {
        sort: "POPULARITY_DESC",
        season: currentSeason,
        year: currentYear,
        format_not: "MUSIC",
      };
      break;
    }
    case "TRENDING":
      variables = { sort: "TRENDING_DESC" };
      break;
    case "ALLPOPULAR":
      variables = { sort: "POPULARITY_DESC" };
      break;
    case "ROMANCE":
    case "ACTION":
    case "ADVENTURE":
    case "FANTASY":
    case "COMEDY":
      variables = { sort: "TRENDING_DESC", genre: [catalogType] };
      break;
    default:
      variables = { status: catalogType };
      break;
  }

  // Build query based on which filter field is provided.
  if (variables.status) {
    query = `query($userId:Int,$sort:[MediaListSort]) {
      MediaListCollection(userId:$userId,type:ANIME,sort:$sort,forceSingleCompletedList:true) {
        lists {
          status,
          entries {
            media {
              id,
              format,
              title {userPreferred},
              coverImage {extraLarge},
              genres,
              averageScore
            }
          }
        }
      }
    }`;
    variables.userId = user.id;
    const status = variables.status;
    delete variables.status;
    const data = await getCachedResult(query, variables, () =>
      makeGraphQLRequest(query, variables, token)
    );
    const lists = data.data.MediaListCollection.lists;
    const mediaList = lists.reduce((acc, list) => {
      if (status.includes(list.status)) {
        return acc.concat(list.entries);
      }
      return acc;
    }, []);
    const entries = mediaList.map((entry) => entry.media);

    return entries.map((media) => ({
      id: `anilist:${media.id}`,
      type: media.format === "MOVIE" ? "movie" : "series",
      name: media.title.userPreferred,
      poster: media.coverImage.extraLarge,
      genres: media.genres,
      imdbRating: media.averageScore,
    }));
  } else if (variables.status_in) {
    query = `query($status_in:[MediaStatus],$id_in:[Int],$id_not_in:[Int],$sort:[MediaSort]) {
      Page {
        media(type:ANIME,status_in:$status_in,id_in:$id_in,id_not_in:$id_not_in,format_not:MUSIC,sort:$sort) {
          id,
          format,
          title {userPreferred},
          coverImage {extraLarge},
          genres,
          averageScore
        }
      }
    }`;
    variables.id_in = variables.id_in || [];
    variables.id_not_in = variables.id_not_in || [];
    const data = await getCachedResult(query, variables, () =>
      makeGraphQLRequest(query, variables, token)
    );
    const entries = data.data.Page.media;
    return entries.map((media) => ({
      id: `anilist:${media.id}`,
      type: media.format === "MOVIE" ? "movie" : "series",
      name: media.title.userPreferred,
      poster: media.coverImage.extraLarge,
      genres: media.genres,
      imdbRating: media.averageScore,
    }));
  } else {
    // Generic browse query.
    query = `query($sort:[MediaSort],$search:String,$genre:[String],$season:MediaSeason,$year:Int,$format_not:MediaFormat) {
      Page {
        media(type:ANIME,sort:$sort,search:$search,genre_in:$genre,season:$season,seasonYear:$year,format_not:$format_not) {
          id,
          format,
          title {userPreferred},
          coverImage {extraLarge},
          genres,
          averageScore
        }
      }
    }`;
    // console.log("Catalog type:", catalogType);
    const data = await getCachedResult(query, variables, () =>
      makeGraphQLRequest(query, variables, token)
    );
    const entries = data.data.Page.media;
    return entries.map((media) => ({
      id: `anilist:${media.id}`,
      type: media.format === "MOVIE" ? "movie" : "series",
      name: media.title.userPreferred,
      poster: media.coverImage.extraLarge,
      genres: media.genres,
      imdbRating: media.averageScore,
    }));
  }
}

module.exports = {
  getCatalog,
  getAnilistEntry,
  updateAnilist,
  handleWatchedEpisode: async (
    animeName,
    anilistId,
    currentEpisode,
    preAddedOnly,
    token
  ) => {
    if (animeName) {
      const entry = await getAnilistEntry(animeName, token);
      if (entry) {
        await updateAnilist(entry.id, currentEpisode, preAddedOnly, token);
      }
    } else if (anilistId) {
      await updateAnilist(anilistId, currentEpisode, preAddedOnly, token);
    }
  },
};
