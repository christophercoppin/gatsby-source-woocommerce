const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;

const {
  processNode,
  normaliseFieldName,
  mapMediaToNodes,
  mapProductsToCategories,
  mapProductsToTags,
  mapRelatedProducts,
  mapGroupedProducts,
  asyncGetProductVariations,
} = require("./helpers");

exports.sourceNodes = async (
  { actions, createNodeId, createContentDigest, store, cache },
  configOptions
) => {
  const { createNode, touchNode } = actions;
  delete configOptions.plugins;

  const {
    api,
    https,
    api_keys,
    fields,
    api_version = "wc/v3",
    per_page,
    wpAPIPrefix = null,
    query_string_auth = false,
    port = "",
    encoding = "",
    axios_config = null,
  } = configOptions;

  // set up WooCommerce node api tool
  const WooCommerce = new WooCommerceRestApi({
    url: `http${https ? "s" : ""}://${api}`,
    consumerKey: api_keys.consumer_key,
    consumerSecret: api_keys.consumer_secret,
    version: api_version,
    wpAPIPrefix,
    queryStringAuth: query_string_auth,
    port,
    encoding,
    axiosConfig: axios_config,
  });

  // Fetch Node data for a given field name
  const fetchNodes = async (fieldName) => {
    let data_ = [];
    let page = 1;
    let pages;

    do {
      let args = per_page ? { per_page, page } : { page };
      await WooCommerce.get(fieldName, args)
        .then((response) => {
          if (response.status === 200) {
            data_ = [...data_, ...response.data];
            pages = parseInt(response.headers["x-wp-totalpages"]);
            page++;
          } else {
            console.warn(`
              ========== WARNING FOR FIELD ${fieldName} ===========
              The following error status was produced: ${response.data}
              ================== END WARNING ==================
            `);
            return [];
          }
        })
        .catch((error) => {
          console.warn(`
            ========== WARNING FOR FIELD ${fieldName} ===========
            The following error status was produced: ${error}
            ================== END WARNING ==================
          `);
          return [];
        });
    } while (page <= pages);

    return data_;
  };

  // Loop over each field set in configOptions and process/create nodes
  async function fetchNodesAndCreate(array) {
    let nodes = [];
    for (const field of array) {
      const fieldName = normaliseFieldName(field);
      let tempNodes = await fetchNodes(field);
      tempNodes = tempNodes.map((node) => ({
        ...node,
        id: createNodeId(`woocommerce-${fieldName}-${node.id}`),
        wordpress_id: node.id,
        wordpress_parent_id: node.parent,
        __type: `wc${fieldName[0].toUpperCase() + fieldName.slice(1)}`,
      }));
      nodes = nodes.concat(tempNodes);
    }

    nodes = await asyncGetProductVariations(nodes, WooCommerce);
    nodes = await mapMediaToNodes({
      nodes,
      store,
      cache,
      createNode,
      createNodeId,
      touchNode,
    });

    nodes = mapProductsToCategories(nodes);
    nodes = mapProductsToTags(nodes);
    nodes = mapRelatedProducts(nodes);
    nodes = mapGroupedProducts(nodes);

    nodes = nodes.map((node) => processNode(createContentDigest, node));

    nodes.forEach((node) => {
      createNode(node);
    });
  }

  await fetchNodesAndCreate(fields);
  return;
};

exports.createSchemaCustomization = ({ actions, schema }, configOptions) => {
  const { createTypes } = actions;
  const { fields } = configOptions;

  const typeDefs = fields.map((field) => {
    const fieldName = normaliseFieldName(field);
    const fieldType = `wc${fieldName[0].toUpperCase() + fieldName.slice(1)}`;
    let extra_fields = {}

    if (fieldName.toLowerCase() === 'products') {
      // Product fields
      extra_fields = {
        price: "String",
      }
    }

    return schema.buildObjectType({
      name: fieldType,
      fields: {
        ...extra_fields,
        wordpress_parent: {
          type: fieldType,
          resolve(source, args, context, info) {
            return context.nodeModel
              .getAllNodes({ type: fieldType })
              .find((node) => node.wordpress_id === source.wordpress_parent_id);
          },
        },
        wordpress_children: {
          type: `[${fieldType}]`,
          resolve(source, args, context, info) {
            return context.nodeModel
              .getAllNodes({ type: fieldType })
              .filter(
                (node) => node.wordpress_parent_id === source.wordpress_id
              );
          },
        },
      },
      interfaces: ["Node"],
    });
  });

  createTypes(typeDefs);
};
