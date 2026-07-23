import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  useCartLines,
  useTotalAmount,
  useInstructions,
  useBuyerJourneyIntercept,
} from "@shopify/ui-extensions/checkout/preact";

export default function extension() {
  render(<Extension />, document.body);
}

const GWP_HANDLE = "app--379210334209--gwp-usymljaq";
const GWP_TYPE = "app--379210334209--gwp";
const EGIFT_PRODUCT_ID = ""; // 추후 GIFT 상품 생기면 적용

function Extension() {
  const cartLines = useCartLines();
  const total = useTotalAmount();
  const instructions = useInstructions();
  const isRemovingRef = useRef(false);
  const isNormalizingGiftQtyRef = useRef(false);
  const isAddingRef = useRef(false);

  useEffect(() => {
    // console.log("[GWP DEBUG] line.cost raw", cartLines.map(l => l.cost));
    // console.log("[GWP DEBUG] line 전체 구조 (첫번째 라인)", cartLines[0]);
    // const sumOfLineTotals = cartLines.reduce(
    //   (sum, l) => sum + Number(l?.cost?.totalAmount?.amount || 0),
    //   0
    // );
    // console.log("[GWP DEBUG] 라인 totalAmount 합 vs 카트 total", {
    //   sumOfLineTotals,
    //   cartTotal: total?.amount, // useTotalAmount()
    // });
    console.log("[GWP DEBUG] cartLines", cartLines);
    
    
  }, [cartLines, total]);
 

  const [gwp, setGwp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [productsWithCollections, setProductsWithCollections] = useState([]);
  const [selectedVariants, setSelectedVariants] = useState({});
  const [isAdding, setIsAdding] = useState(false);

  // const [debugInfo, setDebugInfo] = useState("");

  const totalAmount = useMemo(() => {
    const egiftAmount = cartLines.reduce((sum, line) => {
      if (line?.merchandise?.product?.id === EGIFT_PRODUCT_ID) {
        return sum + Number(line?.cost?.totalAmount?.amount || 0); // 원복
      }
      return sum;
    }, 0);

    return Number(total?.amount || 0) - egiftAmount;
  }, [cartLines, total])
  const currencyCode = "JPY";

  const productIds = useMemo(() => {
    return [
      ...new Set(
        cartLines
          .map((line) => line?.merchandise?.product?.id)
          .filter(Boolean)
      ),
    ];
  }, [cartLines]);

  useEffect(() => {
    fetchGwp();
  }, []);

  useEffect(() => {
    if (!productIds.length) {
      setProductsWithCollections([]);
      return;
    }
    fetchProductCollections(productIds);
  }, [productIds.join(",")]);

  const conditions = useMemo(() => {
    return gwp?.conditions || [];
  }, [gwp]);

  const conditionTypes = useMemo(() => {
    return gwp?.conditionTypes || [];
  }, [gwp]);

  const giftProductIds = useMemo(() => {
    return conditions
      .map((condition) => condition.giftProduct?.id)
      .filter(Boolean);
  }, [conditions]);

  // ── 조건 평가 함수 ──────────────────────────────────────────

  function isAmountConditionMatched(condition) {
    if (!conditionTypes.includes("amount")) return true;

    if (condition.currencyCode !== currencyCode) return false;

    if (condition.collectionOnly) return true;

    return totalAmount >= Number(condition.thresholdAmount || 0);
  }

  function getBundleGroupId(line) {
    const attrs = line.attributes || [];

    // // 1차: _bundle_group_id 필드 우선 사용 (있으면 그대로 신뢰)
    // const directAttr = attrs.find((a) => a.key === "_bundle_group_id");
    // if (directAttr?.value) return directAttr.value;

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

  function isProductConditionMatched(condition) {
    if (!condition.product?.id) return false;

    const productLines = cartLines.filter(
      (line) => line?.merchandise?.product?.id === condition.product.id
    );

    const productQuantity = getEffectiveQuantity(productLines);

    return productQuantity >= Number(condition.productQuantity || 1);
  }

  function isCollectionConditionMatched(condition) {
    if (!condition.collection?.id) return false;

    const collectionLines = cartLines.filter((line) => {
      const productId = line?.merchandise?.product?.id;

      if (isGiftProduct(productId)) return false;
      if (productId === EGIFT_PRODUCT_ID) return false;

      const product = productsWithCollections.find((p) => p.id === productId);
      return product?.collections?.nodes?.some(
        (collection) => collection.id === condition.collection.id
      );
    });
    console.log("[GWP DEBUG] collectionLines 상세", collectionLines.map(line => ({
      productId: line?.merchandise?.product?.id,
      quantity: line.quantity,
      bundleGroupId: (line.attributes || []).find(a => a.key === "_bundle_group_id")?.value || null,
    })));
    console.log("[GWP DEBUG] collectionLines 필터 통과 라인", collectionLines.map(l => ({
      productId: l?.merchandise?.product?.id,
      quantity: l.quantity,
      bundleGroupId: getBundleGroupId(l),
    })));

    const collectionQuantity = getEffectiveQuantity(collectionLines); // reduce 대체

    if (collectionQuantity < Number(condition.collectionQuantity || 1)) {
      return false;
    }

    if (condition.collectionOnly) {
      if (condition.currencyCode !== currencyCode) return false;

      const collectionAmount = collectionLines.reduce((sum, line) => {
        return sum + Number(line?.cost?.totalAmount?.amount || 0);
      }, 0);

      return collectionAmount >= Number(condition.thresholdAmount || 0);
    }

    return true;
  }

  function isConditionMatched(condition) {
    const amountOk =
      !conditionTypes.includes("amount") || isAmountConditionMatched(condition);
    const productOk =
      !conditionTypes.includes("product") || isProductConditionMatched(condition);
    const collectionOk =
      !conditionTypes.includes("collection") || isCollectionConditionMatched(condition);

    return amountOk && productOk && collectionOk;
  }

  // ────────────────────────────────────────────────────────────


  const eligibleCondition = useMemo(() => {
    if (!gwp) return null;
    if (!conditionTypes.length) return null;

    const hasCollectionCondition =
      conditionTypes.includes("collection") ||
      conditions.some((c) => c.collectionOnly);

    if (hasCollectionCondition && collectionsLoading) return null;
    if (!isWithinCampaignPeriod(gwp.startDatetime, gwp.endDatetime)) return null;

    const filtered = conditions.filter((condition) => {
      if (conditionTypes.includes("amount")) {
        return condition.currencyCode === currencyCode;
      }
      return true;
    });

    const matched = filtered.filter(isConditionMatched);

    const sorted = matched.sort((a, b) => {
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
        return (
          Number(b.collectionQuantity || 1) - Number(a.collectionQuantity || 1)
        );
      }

      return 0;
    });

    const result = sorted[0] || null;

    // ── 디버그 로그 ──────────────────────────────────────────
    console.log("[GWP DEBUG] eligibleCondition 계산 과정", {
      totalAmount,
      currencyCode,
      conditionTypes,
      allConditions: conditions.map((c) => ({
        title: c.conditionTitle,
        thresholdAmount: c.thresholdAmount,
        collectionOnly: c.collectionOnly,
        collectionId: c.collection?.id,
        collectionQuantity: c.collectionQuantity,
        currencyCode: c.currencyCode,
      })),
      afterCurrencyFilter: filtered.map((c) => c.conditionTitle),
      afterConditionMatch: matched.map((c) => c.conditionTitle),
      afterSort: sorted.map((c) => ({
        title: c.conditionTitle,
        thresholdAmount: c.thresholdAmount,
      })),
      selected: result?.conditionTitle,
    });
    // ────────────────────────────────────────────────────────

    return result;
  }, [
    gwp,
    conditions,
    conditionTypes,
    totalAmount,
    currencyCode,
    cartLines,
    productsWithCollections,
    collectionsLoading,
    giftProductIds,
  ]);

  const targetProduct = eligibleCondition?.giftProduct || null;
  const targetProductId = targetProduct?.id || null;

  const targetVariantId = useMemo(() => {
    if (!targetProduct) return null;

    const firstAvailableVariant =
      targetProduct.variants.nodes.find((variant) => variant.availableForSale) ||
      targetProduct.variants.nodes[0];

    return firstAvailableVariant?.id || null;
  }, [targetProduct]);

  const targetGiftLine = cartLines.find((line) => {
    const productId = line?.merchandise?.product?.id;
    return productId === targetProductId && isGiftProduct(productId);
  });

  function isGiftProduct(productId) {
    return giftProductIds.includes(productId);
  }

  useEffect(() => {
    if (!targetProduct) {
      setSelectedVariants({});
      return;
    }
    if (targetVariantId) {
      setSelectedVariants({ [targetProduct.id]: targetVariantId });
    }
  }, [targetProduct, targetVariantId]);

  // 잘못된 tier의 gift 자동 제거
  useEffect(() => {
    async function syncGiftTier() {
      if (loading) return; 
      if (isRemovingRef.current) return;
      if (collectionsLoading) return;
      if (!instructions?.lines?.canRemoveCartLine) return;

      const giftLines = cartLines.filter((line) =>
        isGiftProduct(line?.merchandise?.product?.id)
      );

      const linesToRemove = giftLines.filter((line) => {
        const productId = line?.merchandise?.product?.id;
        if (!targetProductId) return true;
        return productId !== targetProductId;
      });

      if (!linesToRemove.length) return;

      isRemovingRef.current = true;

      try {
        for (const line of linesToRemove) {
          await shopify.applyCartLinesChange({
            type: "removeCartLine",
            id: line.id,
            quantity: line.quantity,
          });
        }
      } catch (error) {
        console.error("syncGiftTier remove error", error);
      } finally {
        isRemovingRef.current = false;
      }
    }

    syncGiftTier();
  }, [cartLines, giftProductIds, targetProductId, instructions, loading, collectionsLoading]);

  // gift 수량 1로 고정
  useEffect(() => {
    async function normalizeGiftQuantity() {
      if (isNormalizingGiftQtyRef.current) return;
      if (!instructions?.lines?.canUpdateCartLine) return;

      const giftLines = cartLines.filter((line) =>
        isGiftProduct(line?.merchandise?.product?.id)
      );

      const linesToFix = giftLines.filter((line) => line.quantity > 1);

      if (!linesToFix.length) return;

      isNormalizingGiftQtyRef.current = true;

      try {
        for (const line of linesToFix) {
          await shopify.applyCartLinesChange({
            type: "updateCartLine",
            id: line.id,
            quantity: 1,
          });
        }
      } catch (error) {
        console.error("normalizeGiftQuantity error", error);
      } finally {
        isNormalizingGiftQtyRef.current = false;
      }
    }

    normalizeGiftQuantity();
  }, [cartLines, giftProductIds, instructions]);

  // ── GWP 데이터 fetch ─────────────────────────────────────────

  async function fetchGwp() {
    const query = `
      query getGwp($handle: MetaobjectHandleInput!) {
        metaobject(handle: $handle) {
          id
          handle
          fields {
            key
            value
            reference {
              ... on Product {
                id
                title
                featuredImage { url altText }
                variants(first: 50) {
                  nodes {
                    id title availableForSale
                    price { amount currencyCode }
                    image { url altText }
                  }
                }
              }
              ... on Collection { id title handle }
              ... on Metaobject { id handle }
            }
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
                        featuredImage { url altText }
                        variants(first: 50) {
                          nodes {
                            id title availableForSale
                            price { amount currencyCode }
                            image { url altText }
                          }
                        }
                      }
                      ... on Collection { id title handle }
                    }
                    references(first: 10) {
                      nodes {
                        ... on Product {
                          id title
                          featuredImage { url altText }
                          variants(first: 50) {
                            nodes {
                              id title availableForSale
                              price { amount currencyCode }
                              image { url altText }
                            }
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
      const result = await shopify.query(query, {
        variables: {
          handle: { type: GWP_TYPE, handle: GWP_HANDLE },
        },
      });

      if (result?.errors?.length) {
        throw new Error(result.errors.map((e) => e.message).join(" / "));
      }

      const metaobject = result?.data?.metaobject;

      if (!metaobject) {
        setGwp(null);
        return;
      }

      setGwp(parseGwp(metaobject));
    } catch (error) {
      console.error("fetchGwp error", error);
      setGwp(null);
    } finally {
      setLoading(false);
    }
  }

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

  // ── 파싱 ─────────────────────────────────────────────────────

  function parseGwp(metaobject) {
    const fields = getFieldsMap(metaobject.fields);
    const conditionNodes =
      metaobject.fields.find((f) => f.key === "conditions")?.references?.nodes || [];

    return {
      id: metaobject.id,
      handle: metaobject.handle,
      title: fields.title,
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
      handle: metaobject.handle,
      conditionTitle: fields.condition_title,
      thresholdAmount: fields.threshold_amount,
      currencyCode: "JPY",
      product: getReferenceByKey(metaobject.fields, "product"),
      productQuantity: fields.product_quantity,
      collection: getReferenceByKey(metaobject.fields, "collection"),
      collectionOnly: fields.collection_only === "true",
      collectionQuantity: fields.collection_quantity,
      giftProduct: getReferenceByKey(metaobject.fields, "gift_product"),
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
    return fields.reduce((acc, field) => {
      acc[field.key] = field.value;
      return acc;
    }, {});
  }

  function getReferenceByKey(fields, key) {
    const field = fields.find((f) => f.key === key);
    return field?.reference || field?.references?.nodes?.[0] || null;
  }

  function isWithinCampaignPeriod(startDatetime, endDatetime) {
    const now = new Date();

    if (startDatetime) {
      const start = new Date(startDatetime);
      if (now < start) return false;
    }

    if (endDatetime) {
      const end = new Date(endDatetime);
      if (now > end) return false;
    }

    return true;
  }

  // ── 카트 유틸 ────────────────────────────────────────────────

  function isInCart(variantId) {
    return cartLines.some((line) => line.merchandise.id === variantId);
  }

  async function addToCart(variantId) {
    if (isAddingRef.current) return;

    isAddingRef.current = true;
    setIsAdding(true);

    try {
      await shopify.applyCartLinesChange({
        type: "addCartLine",
        merchandiseId: variantId,
        quantity: 1,
      });
    } finally {
      isAddingRef.current = false;
      setIsAdding(false);
    }
  }

  function handleVariantChange(productId, variantId) {
    setSelectedVariants((prev) => ({ ...prev, [productId]: variantId }));
  }

  // ── Buyer Journey Intercept ──────────────────────────────────

  useBuyerJourneyIntercept(({ canBlockProgress }) => {
    if (!canBlockProgress) return { behavior: "allow" };
    if (loading || collectionsLoading) return { behavior: "allow" };
    if (!eligibleCondition) return { behavior: "allow" };

    const hasGwp = cartLines.some(
      (line) => line?.merchandise?.product?.id === targetProductId
    );

    if (!hasGwp) {
      return {
        behavior: "block",
        reason: "Please select your complimentary anniversary gift before completing checkout.",
      };
    }

    return { behavior: "allow" };
  });


  if (loading || collectionsLoading) {
    return (
      <s-box background="subdued" borderRadius="base" borderWidth="base" padding="base">
        <s-stack direction="inline" gap="small-100" alignItems="center">
          <s-spinner />
          <s-text>Loading gift…</s-text>
        </s-stack>
      </s-box>
    );
  }

  if (!eligibleCondition) return null;
  if (!targetProduct) return null;
  if (targetGiftLine) return null;

  const variants = targetProduct.variants.nodes;
  const defaultVariant =
    variants.find((variant) => variant.availableForSale) || variants[0];

  const selectedVariantId = selectedVariants[targetProduct.id] || defaultVariant?.id;
  const selectedVariant = variants.find((variant) => variant.id === selectedVariantId);

  if (!selectedVariant) return null;

  return (
    <s-box background="subdued" borderRadius="base" borderWidth="base" padding="base">
      <s-section>
        <s-stack gap="small-100">
          <s-text size="medium" emphasis="bold">
            プレゼントを選択
          </s-text>

          <s-text>特典のプレゼントが利用可能です。</s-text>

          <s-grid
            gridTemplateColumns="auto minmax(0, 1fr)"
            gap="base"
            alignItems="center"
          >
            <s-product-thumbnail
              src={selectedVariant?.image?.url || targetProduct.featuredImage?.url}
            />

            <s-grid
              gridTemplateColumns="minmax(0, 1fr) auto"
              gap="small-100"
              alignItems="end"
            >
              <s-box minInlineSize="0">
                <s-select
                  label="Option"
                  value={selectedVariantId}
                  onChange={(event) =>
                    handleVariantChange(targetProduct.id, event.target.value)
                  }
                >
                  {variants.map((variant) => (
                    <s-option key={variant.id} value={variant.id}>
                      {variant.title} - {variant.price.amount}{" "}
                      {variant.price.currencyCode}
                    </s-option>
                  ))}
                </s-select>
              </s-box>

              {isInCart(selectedVariantId) ? (
                <s-box>
                  <s-text>1 item added</s-text>
                </s-box>
              ) : (
                <s-button
                  size="small"
                  variant="primary"
                  disabled={
                    isAdding ||
                    !selectedVariant?.availableForSale ||
                    !instructions?.lines?.canAddCartLine
                  }
                  onClick={() => addToCart(selectedVariantId)}
                >
                  追加
                </s-button>
              )}
            </s-grid>
          </s-grid>
        </s-stack>
      </s-section>
    </s-box>
  );
}