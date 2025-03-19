const axios = require("axios");
const LRU = require("lru-cache");
const { getFromDatabase, cacheToDatabase } = require("./sqlite");

const memoryCache = new LRU({
  max: 10000,
});

async function getId(id, source, target = "anilist") {
  // console.log(`getId: ${id}, ${source}, ${target}`);
  const cacheKey = `${source}:${target}:${id}`;

  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey);
  }

  const cachedId = await getFromDatabase(id, target);
  if (cachedId) {
    memoryCache.set(cacheKey, cachedId);
    return cachedId;
  }

  const targetId = await fetchId(id, source, target);
  if (targetId) {
    memoryCache.set(cacheKey, targetId);
    await cacheToDatabase(targetId, id, target);
  }

  return targetId;
}

async function fetchId(id, source, target) {
  try {
    const response = await axios.get(
      `https://arm.haglund.dev/api/v2/ids?source=${source}&id=${id}&include=${target}`
    );
    const targetId = response.data?.[target];
    return targetId;
  } catch (err) {
    console.error(err);
    return null;
  }
}

module.exports = {
  getId,
};
