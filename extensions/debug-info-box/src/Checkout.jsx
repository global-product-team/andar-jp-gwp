import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  useCartLines,
  useTotalAmount,
  useInstructions,
} from "@shopify/ui-extensions/checkout/preact";

export default function extension() {
  render(<DebugExtension />, document.body);
}

const GWP_HANDLE = "app--379210334209--gwp-usymljaq";
const GWP_TYPE = "app--379210334209--gwp";
function DebugExtension() {
  const cartLines = useCartLines();
  const total = useTotalAmount();
  const instructions = useInstructions();

  const [gwp, setGwp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [productsWithCollections, setProductsWithCollections] = useState([]);
  const [collectionsLoading, setCollectionsLoading] = useState(false);

  const totalAmount = Number(total?.amount ?? 0);
  const currencyCode = "JPY";

  useEffect(() => {
    fetchGwp();
  }, []);

  const productIds = useMemo(() => {
    return [
      ...new Set(
        cartLines
          .map((line) => line?.merchandise?.product?.id)
          .filter(Boolean)
      ),
    ];
  }, [cartLines]);

  async function fetchProductCollections(ids) {
    setCollectionsLoading(true);

    const query = `
      query getProductCollections($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            collections(first: 50) {
              nodes { id handle title }
            }
          }
        }
      }
    `;

    try {
      const result = await shopify.query(query, {
        variables: { ids },
      });

      if (result?.errors?.length) {
        throw new Error(result.errors.map((e) => e.message).join(" / "));
      }

      setProductsWithCollections(result?.data?.nodes?.filter(Boolean) || []);
    } catch (error) {
      console.error("fetchProductCollections error", error);
      setProductsWithCollections([]);
    } finally {
      setCollectionsLoading(false);
    }
  }

  useEffect(() => {
    if (!productIds.length) {
      setProductsWithCollections([]);
      return;
    }

    fetchProductCollections(productIds);
  }, [productIds.join(",")]);

  async function fetchGwp() {
    const query = `
      query getGwp($handle: MetaobjectHandleInput!) {
        metaobject(handle: $handle) {
          id
          handle
          fields {
            key
            value
            references(first: 20) {
              nodes {
                ... on Metaobject {
                  id
                  handle
                  fields {
                    key
                    value
                    reference {
                      ... on Product {
                        id
                        title
                        variants(first: 50) {
                          nodes {
                            id
                            title
                            availableForSale
                          }
                        }
                      }
                      ... on Collection {
                        id
                        title
                        handle
                      }
                    }
                    references(first: 10) {
                      nodes {
                        ... on Product {
                          id
                          title
                          variants(first: 50) {
                            nodes {
                              id
                              title
                              availableForSale
                            }
                          }
                        }
                        ... on Collection {
                          id
                          title
                          handle
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    try {
      const { data } = await shopify.query(query, {
        variables: { handle: { type: GWP_TYPE, handle: GWP_HANDLE } },
      });
      const metaobject = data?.metaobject;
      setGwp(metaobject ? parseGwp(metaobject) : null);
    } catch (error) {
      setGwp(null);
    } finally {
      setLoading(false);
    }
  }

  function parseGwp(metaobject) {
    const fields = getFieldsMap(metaobject.fields);
    const conditionNodes =
      metaobject.fields.find((f) => f.key === "conditions")?.references?.nodes || [];
    return {
      startDatetime: fields.start_datetime,
      endDatetime: fields.end_datetime,
      conditionTypes: JSON.parse(fields.condition_type || "[]"),
      conditions: conditionNodes.map(parseCondition),
    };
  }

  function parseCondition(metaobject) {
    const fields = getFieldsMap(metaobject.fields);
    return {
      id: metaobject.id,
      conditionTitle: fields.condition_title,
      currencyCode: "JPY",
      thresholdAmount: fields.threshold_amount,
      collectionOnly: fields.collection_only === "true",
      collectionQuantity: fields.collection_quantity,
      productQuantity: fields.product_quantity,
      giftProduct: getReferenceByKey(metaobject.fields, "gift_product"),
      collection: getReferenceByKey(metaobject.fields, "collection"),
      product: getReferenceByKey(metaobject.fields, "product"),
    };
  }

  function getFieldsMap(fields) {
    return fields.reduce((acc, f) => { acc[f.key] = f.value; return acc; }, {});
  }

  function getReferenceByKey(fields, key) {
    const field = fields.find((f) => f.key === key);
    return field?.reference || field?.references?.nodes?.[0] || null;
  }

  function isWithinCampaignPeriod(startDatetime, endDatetime) {
    const now = new Date();
    if (startDatetime && now < new Date(startDatetime)) return false;
    if (endDatetime && now > new Date(endDatetime)) return false;
    return true;
  }

  const conditionTypes = gwp?.conditionTypes || [];
  const conditions = gwp?.conditions || [];

  const giftProductIds = useMemo(() =>
    conditions.map((c) => c.giftProduct?.id).filter(Boolean),
  [conditions]);

  const campaignActive = gwp
    ? isWithinCampaignPeriod(gwp.startDatetime, gwp.endDatetime)
    : false;


  const conditionDebugRows = useMemo(() => {
    return conditions.map((condition) => {
      const matchedProductQty = cartLines
        .filter((line) => line?.merchandise?.product?.id === condition.product?.id)
        .reduce((sum, line) => sum + Number(line.quantity || 0), 0);

      const collectionLines = cartLines.filter((line) => {
        const productId = line?.merchandise?.product?.id;
        if (!productId) return false;

        const product = productsWithCollections.find((p) => p.id === productId);

        return product?.collections?.nodes?.some(
          (collection) => collection.id === condition.collection?.id
        );
      });

      const matchedCollectionQty = collectionLines.reduce((sum, line) => {
        return sum + Number(line.quantity || 0);
      }, 0);

      const matchedCollectionAmount = collectionLines.reduce((sum, line) => {
        return sum + Number(line?.cost?.totalAmount?.amount || 0);
      }, 0);

      const amountOk =
        !conditionTypes.includes("amount") ||
        (
          condition.currencyCode === currencyCode &&
          (
            condition.collectionOnly ||
            totalAmount >= Number(condition.thresholdAmount || 0)
          )
        );

      const productOk =
        !conditionTypes.includes("product") ||
        matchedProductQty >= Number(condition.productQuantity || 1);

      const collectionOk =
        !conditionTypes.includes("collection") ||
        (
          matchedCollectionQty >= Number(condition.collectionQuantity || 1) &&
          (
            !condition.collectionOnly ||
            matchedCollectionAmount >= Number(condition.thresholdAmount || 0)
          )
        );

      const matched = amountOk && productOk && collectionOk;

      let sortScore = 0;

      if (conditionTypes.includes("amount")) {
        sortScore = Number(condition.thresholdAmount || 0);
      } else if (conditionTypes.includes("product")) {
        sortScore = Number(condition.productQuantity || 1);
      } else if (conditionTypes.includes("collection")) {
        sortScore = Number(condition.collectionQuantity || 1);
      }

      return {
        ...condition,
        matchedProductQty,
        matchedCollectionQty,
        matchedCollectionAmount,
        amountOk,
        productOk,
        collectionOk,
        matched,
        sortScore,
      };
    });
  }, [
    conditions,
    conditionTypes,
    cartLines,
    totalAmount,
    currencyCode,
    productsWithCollections,
  ]);

  const eligibleCondition = useMemo(() => {
    if (!gwp || !campaignActive) return null;

    return (
      conditionDebugRows
        .filter((condition) => condition.matched)
        .sort((a, b) => {
          if (conditionTypes.includes("amount")) {
            const amountDiff =
              Number(b.thresholdAmount || 0) - Number(a.thresholdAmount || 0);

            if (amountDiff !== 0) return amountDiff;
            return 0;
          }

          if (conditionTypes.includes("product")) {
            return Number(b.productQuantity || 1) - Number(a.productQuantity || 1);
          }

          if (conditionTypes.includes("collection")) {
            return Number(b.collectionQuantity || 1) - Number(a.collectionQuantity || 1);
          }

          return 0;
        })[0] || null
    );
  }, [gwp, campaignActive, conditionDebugRows, conditionTypes]);

  const targetProductId = eligibleCondition?.giftProduct?.id || null;

  const giftLines = cartLines.filter((line) =>
    giftProductIds.includes(line?.merchandise?.product?.id)
  );

  // 삭제돼야 할 라인 (현재 타겟이 아닌 GWP 라인들)
  const linesToRemove = giftLines.filter((line) => {
    if (!targetProductId) return true;
    return line?.merchandise?.product?.id !== targetProductId;
  });

  const canRemove = instructions?.lines?.canRemoveCartLine;
  const canUpdate = instructions?.lines?.canUpdateCartLine;
  const canAdd = instructions?.lines?.canAddCartLine;

  // 삭제가 필요한데 권한이 막혀있는지
  const removeBlockedByPermission = linesToRemove.length > 0 && !canRemove;

  if (loading || collectionsLoading) {
    return (
      <s-box background="subdued" borderRadius="base" borderWidth="base" padding="base">
        <s-text>🛠 GWP Debug loading...</s-text>
      </s-box>
    );
  }  

  return (
    <s-box background="subdued" borderRadius="base" borderWidth="base" padding="base" inlineSize="fill">
      <s-stack gap="small-100">

        <s-text size="medium" emphasis="bold">🛠 GWP Debug</s-text>
        <s-text>version: 2026-06-12-01</s-text>

        {/* 캠페인 상태 */}
        <s-text emphasis="bold">── Campaign ──</s-text>
        <s-text>campaignActive: {String(campaignActive)}</s-text>
        <s-text>start: {gwp?.startDatetime || "none"}</s-text>
        <s-text>end: {gwp?.endDatetime || "none"}</s-text>

        {/* 조건 */}
        <s-text emphasis="bold">── Conditions ──</s-text>
        <s-text>conditionTypes: {JSON.stringify(conditionTypes)}</s-text>
        <s-text>totalAmount: {totalAmount} {currencyCode}</s-text>
        {conditionDebugRows.map((c, i) => (
          <s-text key={c.id}>
            [{i}] {c.conditionTitle || c.id}
            {" | matched: "}{String(c.matched)}
            {" | amountOk: "}{String(c.amountOk)}
            {" | productOk: "}{String(c.productOk)}
            {" | productQty: "}{c.matchedProductQty}/{c.productQuantity || 1}
            {" | collectionOk: "}{String(c.collectionOk)}
            {" | collectionQty: "}{c.matchedCollectionQty}/{c.collectionQuantity || 1}
            {" | collectionAmount: "}{c.matchedCollectionAmount}
            {" | collectionOnly: "}{String(c.collectionOnly)}
            {" | currency: "}{c.currencyCode}
            {" | currentCurrency: "}{currencyCode}
            {" | needAmount: "}{c.thresholdAmount}
            {" | currentCollectionAmount: "}{c.matchedCollectionAmount}
            {" | threshold: "}{c.thresholdAmount || "-"} {c.currencyCode || ""}
            {" | sortScore: "}{c.sortScore}
            {" | gift: "}{c.giftProduct?.title || "none"}
          </s-text>
        ))}
        <s-text>
          eligibleCondition: {eligibleCondition
            ? `${eligibleCondition.conditionTitle || eligibleCondition.id} → ${eligibleCondition.giftProduct?.title}`
            : "none"}
        </s-text>
        <s-text>
          targetProduct: {targetProductId || "none"}
        </s-text>
        <s-text>
          currency: {currencyCode}
        </s-text>

        {/* 권한 */}
        <s-text emphasis="bold">── Permissions ──</s-text>
        <s-text>canAddCartLine: {String(canAdd)}</s-text>
        <s-text>canUpdateCartLine: {String(canUpdate)}</s-text>
        <s-text>canRemoveCartLine: {String(canRemove)}</s-text>

        {/* GWP 장바구니 상태 */}
        <s-text emphasis="bold">── GWP Cart Lines ──</s-text>
        <s-text>giftProductIds: {JSON.stringify(giftProductIds)}</s-text>
        <s-text>giftLinesInCart: {giftLines.length}</s-text>
        {giftLines.map((line) => (
          <s-text key={line.id}>
            • {line?.merchandise?.product?.title} / {line?.merchandise?.title} × {line.quantity}
          </s-text>
        ))}

        {/* 삭제 필요 여부 */}
        <s-text emphasis="bold">── Remove Diagnosis ──</s-text>
        <s-text>linesToRemove: {linesToRemove.length}</s-text>
        <s-text>
          removeBlockedByPermission: {String(removeBlockedByPermission)}
        </s-text>
        {removeBlockedByPermission && (
          <s-text>
            ⚠️ GWP 삭제 필요하지만 canRemoveCartLine = false 로 막혀있음
          </s-text>
        )}
        {linesToRemove.length > 0 && canRemove && (
          <s-text>✅ 권한은 있음 — syncGiftTier 로직 확인 필요</s-text>
        )}
        {linesToRemove.length === 0 && (
          <s-text>삭제 대상 없음 (정상)</s-text>
        )}

      </s-stack>
    </s-box>
  );
}