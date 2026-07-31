import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
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
const EGIFT_PRODUCT_ID = ""; // gwp-checkout-ui와 동일하게 유지

function DebugExtension() {
  const cartLines = useCartLines();
  const total = useTotalAmount();
  const instructions = useInstructions();

  const [gwp, setGwp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [productsWithCollections, setProductsWithCollections] = useState([]);
  const [collectionsLoading, setCollectionsLoading] = useState(false);

  const currencyCode = "JPY";

  // ── totalAmount: eGift 제외 (gwp-checkout-ui와 동일) ────────
  const totalAmount = useMemo(() => {
    const egiftAmount = cartLines.reduce((sum, line) => {
      if (line?.merchandise?.product?.id === EGIFT_PRODUCT_ID) {
        return sum + Number(line?.cost?.totalAmount?.amount || 0);
      }
      return sum;
    }, 0);

    return Number(total?.amount || 0) - egiftAmount;
  }, [cartLines, total]);

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
      const result = await shopify.query(query, { variables: { ids } });

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
                          nodes { id title availableForSale }
                        }
                      }
                      ... on Collection { id title handle }
                    }
                    references(first: 10) {
                      nodes {
                        ... on Product {
                          id
                          title
                          variants(first: 50) {
                            nodes { id title availableForSale }
                          }
                        }
                        ... on Collection { id title handle }
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
      console.error("fetchGwp error", error);
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
      conditionTypes: parseConditionTypes(fields.condition_type),
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

  function parseConditionTypes(value) {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [value];
    }
  }

  function getFieldsMap(fields) {
    return fields.reduce((acc, f) => {
      acc[f.key] = f.value;
      return acc;
    }, {});
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

  function getBundleGroupId(line) {
    const attrs = line.attributes || [];

    // 1차: _bundle_group_id 필드 우선 사용 (있으면 그대로 신뢰)
    const directAttr = attrs.find((a) => a.key === "_bundle_group_id");
    if (directAttr?.value) return directAttr.value;

    // 2차: 없으면 'Part of' 속성에서 (group xxxxx) 패턴 추출
    const partOfAttr = attrs.find((a) => a.key === "Part of");
    if (partOfAttr?.value) {
      const match = partOfAttr.value.match(/\(group\s+([^\)]+)\)/);
      if (match) return match[1].trim();
    }

    return null; // 세트 아님 (단품)
  }

  function getEffectiveQuantity(lines) {
    const seenGroupIds = new Set();
    let total = 0;

    for (const line of lines) {
      const groupId = getBundleGroupId(line); // 위 수정된 함수 사용
      if (groupId) {
        if (!seenGroupIds.has(groupId)) {
          seenGroupIds.add(groupId);
          total += 1;
        }
      } else {
        total += Number(line.quantity || 0);
      }
    }

    return total;
  }

  function getBundleTitle(line) {
    const attrs = line.attributes || [];
    const partOfAttr = attrs.find((a) => a.key === "Part of");
    if (!partOfAttr?.value) return null;

    const match = partOfAttr.value.match(/Bundle\s+(.+?)\s*\(group\s+[^)]+\)\s*$/);
    if (!match) return null;

    // \u201C = " (왼쪽 스마트 따옴표), \u201D = " (오른쪽 스마트 따옴표)
    // 일반 따옴표(", '), 전각 따옴표 등도 함께 커버
    return match[1]
      .replace(/^[\s\u201C\u201D\u2018\u2019"'ff]+/, "")
      .replace(/[\s\u201C\u201D\u2018\u2019"'ff]+$/, "")
      .trim();
  }

  const conditionTypes = gwp?.conditionTypes || [];
  const conditions = gwp?.conditions || [];

  const giftProductIds = useMemo(
    () => conditions.map((c) => c.giftProduct?.id).filter(Boolean),
    [conditions]
  );

  function isGiftProduct(productId) {
    return giftProductIds.includes(productId);
  }

  const campaignActive = gwp
    ? isWithinCampaignPeriod(gwp.startDatetime, gwp.endDatetime)
    : false;

  // ── 조건별 판정 (gwp-checkout-ui의 isConditionMatched 로직과 1:1 동기화) ──
  const conditionDebugRows = useMemo(() => {
    return conditions.map((condition) => {
      // -- product 조건 (id 매칭 우선, 단 세트 구성품 제외 / 안 되면 번들 타이틀 폴백) --
      const productLinesById = condition.product?.id
        ? cartLines.filter((line) => {
            if (line?.merchandise?.product?.id !== condition.product.id) return false;
            const isPartOfBundle = !!getBundleGroupId(line);
            return !isPartOfBundle; // 세트 구성품이면 제외
          })
        : [];

      const productLinesByBundleTitle = condition.product?.title
        ? cartLines.filter((line) => {
            const bundleTitle = getBundleTitle(line);
            return bundleTitle && bundleTitle === condition.product.title;
          })
        : [];

      const productLines = productLinesById.length
        ? productLinesById
        : productLinesByBundleTitle;

      const matchedProductQty = getEffectiveQuantity(productLines);

      const productOk =
        !conditionTypes.includes("product") ||
        (!!condition.product?.id &&
          matchedProductQty >= Number(condition.productQuantity || 1));

      // -- collection 조건 (변경 없음, 기존 그대로) --
      const collectionLines = condition.collection?.id
        ? cartLines.filter((line) => {
            const productId = line?.merchandise?.product?.id;

            if (isGiftProduct(productId)) return false;
            if (productId === EGIFT_PRODUCT_ID) return false;

            const product = productsWithCollections.find((p) => p.id === productId);
            return product?.collections?.nodes?.some(
              (collection) => collection.id === condition.collection.id
            );
          })
        : [];

      const matchedCollectionQty = getEffectiveQuantity(collectionLines);

      const matchedCollectionAmount = collectionLines.reduce(
        (sum, line) => sum + Number(line?.cost?.totalAmount?.amount || 0),
        0
      );

      const collectionQtyOk =
        !!condition.collection?.id &&
        matchedCollectionQty >= Number(condition.collectionQuantity || 1);

      const collectionAmountOk =
        !condition.collectionOnly ||
        (condition.currencyCode === currencyCode &&
          matchedCollectionAmount >= Number(condition.thresholdAmount || 0));

      const collectionOk =
        !conditionTypes.includes("collection") ||
        (collectionQtyOk && collectionAmountOk);

      // -- amount 조건 (변경 없음) --
      const amountOk =
        !conditionTypes.includes("amount") ||
        (condition.currencyCode === currencyCode &&
          (condition.collectionOnly ||
            totalAmount >= Number(condition.thresholdAmount || 0)));

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
    giftProductIds,
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
            if (conditionTypes.includes("collection")) {
              const collectionQtyDiff =
                Number(b.collectionQuantity || 1) - Number(a.collectionQuantity || 1);
              if (collectionQtyDiff !== 0) return collectionQtyDiff;
            }

            if (conditionTypes.includes("product")) {
              const productQtyDiff =
                Number(b.productQuantity || 1) - Number(a.productQuantity || 1);
              if (productQtyDiff !== 0) return productQtyDiff;
            }

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

  const linesToRemove = giftLines.filter((line) => {
    if (!targetProductId) return true;
    return line?.merchandise?.product?.id !== targetProductId;
  });

  const canRemove = instructions?.lines?.canRemoveCartLine;
  const canUpdate = instructions?.lines?.canUpdateCartLine;
  const canAdd = instructions?.lines?.canAddCartLine;

  const removeBlockedByPermission = linesToRemove.length > 0 && !canRemove;

  if (loading || collectionsLoading) {
    return (
      <s-box background="subdued" borderRadius="base" borderWidth="base" padding="base">
        <s-text>🛠 GWP Debug loading...</s-text>
      </s-box>
    );
  }

  return (
    <s-details>
      <s-summary size="medium" emphasis="bold">🛠 GWP Debug</s-summary>
      <s-box background="subdued" borderRadius="base" borderWidth="base" padding="base" inlineSize="fill">
        <s-stack gap="small-100">
          <s-text>version: 2026-07-31</s-text>

          <s-text emphasis="bold">── Campaign ──</s-text>
          <s-text>campaignActive: {String(campaignActive)}</s-text>
          <s-text>start: {gwp?.startDatetime || "none"}</s-text>
          <s-text>end: {gwp?.endDatetime || "none"}</s-text>

          <s-text emphasis="bold">── Conditions ──</s-text>
          <s-text>conditionTypes: {JSON.stringify(conditionTypes)}</s-text>
          <s-text>totalAmount(eGift 제외): {totalAmount} {currencyCode}</s-text>
          <s-text>cartTotal(raw): {total?.amount} {total?.currencyCode}</s-text>

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
          <s-text>targetProduct: {targetProductId || "none"}</s-text>

          <s-text emphasis="bold">── Permissions ──</s-text>
          <s-text>canAddCartLine: {String(canAdd)}</s-text>
          <s-text>canUpdateCartLine: {String(canUpdate)}</s-text>
          <s-text>canRemoveCartLine: {String(canRemove)}</s-text>

          <s-text emphasis="bold">── GWP Cart Lines ──</s-text>
          <s-text>giftLinesInCart: {giftLines.length}</s-text>
          {giftLines.map((line) => (
            <s-text key={line.id}>
              • {line?.merchandise?.product?.title} / {line?.merchandise?.title} × {line.quantity}
            </s-text>
          ))}

          <s-text emphasis="bold">── Remove Diagnosis ──</s-text>
          <s-text>linesToRemove: {linesToRemove.length}</s-text>
          <s-text>removeBlockedByPermission: {String(removeBlockedByPermission)}</s-text>
          {removeBlockedByPermission && (
            <s-text>⚠️ GWP 삭제 필요하지만 canRemoveCartLine = false 로 막혀있음</s-text>
          )}
          {linesToRemove.length > 0 && canRemove && (
            <s-text>✅ 권한은 있음 — syncGiftTier 로직 확인 필요</s-text>
          )}
          {linesToRemove.length === 0 && (
            <s-text>삭제 대상 없음 (정상)</s-text>
          )}

          <s-text emphasis="bold">── Raw Cart Lines ──</s-text>
          {cartLines.map((line) => (
            <s-text key={line.id}>
              • {line?.merchandise?.product?.title || line?.merchandise?.id} × {line.quantity}
              {" | totalAmount: "}{line?.cost?.totalAmount?.amount}
              {" | discountAllocations: "}{JSON.stringify(line?.discountAllocations || [])}
            </s-text>
          ))}
        </s-stack>
      </s-box>
    </s-details>
  );
}