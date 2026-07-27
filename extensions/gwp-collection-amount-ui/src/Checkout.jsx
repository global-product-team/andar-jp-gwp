import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  useCartLines,
  useTotalAmount,
} from "@shopify/ui-extensions/checkout/preact";

export default function extension() {
  render(<Extension />, document.body);
}

const GWP_HANDLE = "app--379210334209--gwp-usymljaq";
const GWP_TYPE = "app--379210334209--gwp";

const EGIFT_PRODUCT_ID = "";
const CURRENCY_CODE = "JPY";

function Extension() {
  const cartLines = useCartLines();
  const total = useTotalAmount();

  const [gwp, setGwp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [productsWithCollections, setProductsWithCollections] = useState([]);

  const cartTotalAmount = useMemo(() => Math.max(Number(total?.amount || 0), 0), [total]);

  const productIds = useMemo(() => {
    return [
      ...new Set(
        cartLines.map((line) => line?.merchandise?.product?.id).filter(Boolean)
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

  const conditions = useMemo(() => gwp?.conditions || [], [gwp]);
  const conditionTypes = useMemo(() => gwp?.conditionTypes || [], [gwp]);

  const giftProductIds = useMemo(
    () => conditions.map((c) => c.giftProduct?.id).filter(Boolean),
    [conditions]
  );

  // ── 세트(번들) 그룹 ID 추출 / 유효 수량 계산 (gwp-checkout-ui와 동일 로직) ──
  function getBundleGroupId(line) {
    const attrs = line.attributes || [];
    const partOfAttr = attrs.find((a) => a.key === "Part of");
    if (partOfAttr?.value) {
      const match = partOfAttr.value.match(/\(group\s+([^)]+)\)/);
      if (match) return match[1].trim();
    }
    return null;
  }

  function getEffectiveQuantity(lines) {
    const seenGroupIds = new Set();
    let total = 0;

    for (const line of lines) {
      const groupId = getBundleGroupId(line);
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

  /*
   * 배너 후보 조건 계산 (트리거 방식 C)
   *
   * collectionOnly 조건 중, 수량은 충족했고
   * "카트 총액(할인 반영 후)은 threshold를 넘어 보이는데,
   *  실제 해당 컬렉션 상품 합계는 threshold 미달"인 경우만 후보로 사용.
   * → 할인 유무와 무관하게, 스코프(카트 전체 vs 특정 컬렉션) 착시를 겨냥.
   */
  const warningConditionInfos = useMemo(() => {
    if (!conditionTypes.includes("amount")) return [];
    if (!conditionTypes.includes("collection")) return [];

    return conditions
      .map((condition, originalIndex) => {
        if (!condition.collectionOnly) return null;
        if (!condition.collection?.id) return null;
        if (condition.currencyCode !== CURRENCY_CODE) return null;

        const collectionLines = cartLines.filter((line) => {
          const productId = line?.merchandise?.product?.id;
          if (!productId) return false;
          if (productId === EGIFT_PRODUCT_ID) return false;
          if (giftProductIds.includes(productId)) return false;
          const product = productsWithCollections.find((item) => item.id === productId);
          return product?.collections?.nodes?.some(
            (collection) => collection.id === condition.collection.id
          );
        });

        const collectionQuantity = getEffectiveQuantity(collectionLines);
        const requiredQuantity = Number(condition.collectionQuantity || 1);

        const currentAmount = collectionLines.reduce(
          (sum, line) => sum + Number(line?.cost?.totalAmount?.amount || 0),
          0
        );

        const thresholdAmount = Number(condition.thresholdAmount || 0);
        const looksMatchedByCartTotal = cartTotalAmount >= thresholdAmount;

        // ↓↓↓ 디버그 로그 (조건마다 각 단계 결과 확인)
        console.log("[GWP BANNER DEBUG]", {
          conditionTitle: condition.conditionTitle,
          collectionOnly: condition.collectionOnly,
          collectionId: condition.collection?.id,
          currencyCode: condition.currencyCode,
          collectionQuantity,
          requiredQuantity,
          qtyOk: collectionQuantity >= requiredQuantity,
          currentAmount,
          thresholdAmount,
          amountAlreadyMatched: currentAmount >= thresholdAmount,
          cartTotalAmount,
          looksMatchedByCartTotal,
        });

        if (collectionQuantity < requiredQuantity) return null;
        if (currentAmount >= thresholdAmount) return null;
        if (!looksMatchedByCartTotal) return null;

        return {
          id: condition.id,
          originalIndex,
          collectionTitle: condition.collection?.title || "対象コレクション",
          currentAmount,
          thresholdAmount,
          remainingAmount: thresholdAmount - currentAmount,
        };
      })
      .filter(Boolean);
  }, [conditions, conditionTypes, cartLines, productsWithCollections, giftProductIds, cartTotalAmount]);

  const activeWarningInfo = useMemo(() => {
    if (!warningConditionInfos.length) return null;

    // 부족액이 가장 적은 조건 우선 (여러 collectionOnly 조건이 후보일 때)
    return [...warningConditionInfos].sort(
      (a, b) => a.remainingAmount - b.remainingAmount
    )[0];
  }, [warningConditionInfos]);

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
              }

              ... on Collection {
                id
                title
                handle
              }
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
    `;

    try {
      const result = await shopify.query(query, {
        variables: {
          handle: {
            type: GWP_TYPE,
            handle: GWP_HANDLE,
          },
        },
      });

      if (result?.errors?.length) {
        throw new Error(
          result.errors
            .map((error) => error.message)
            .join(" / ")
        );
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
              nodes {
                id
                handle
                title
              }
            }
          }
        }
      }
    `;

    try {
      const result = await shopify.query(query, {
        variables: {
          ids,
        },
      });

      if (result?.errors?.length) {
        throw new Error(
          result.errors
            .map((error) => error.message)
            .join(" / ")
        );
      }

      setProductsWithCollections(
        result?.data?.nodes?.filter(Boolean) || []
      );
    } catch (error) {
      console.error(
        "fetchProductCollections error",
        error
      );

      setProductsWithCollections([]);
    } finally {
      setCollectionsLoading(false);
    }
  }

  function parseGwp(metaobject) {
    const fields = getFieldsMap(metaobject.fields);

    const conditionNodes =
      metaobject.fields.find(
        (field) => field.key === "conditions"
      )?.references?.nodes || [];

    return {
      id: metaobject.id,
      handle: metaobject.handle,
      title: fields.title,
      startDatetime: fields.start_datetime,
      endDatetime: fields.end_datetime,
      conditionTypes: parseConditionTypes(
        fields.condition_type
      ),
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
      currencyCode: CURRENCY_CODE,

      collection: getReferenceByKey(
        metaobject.fields,
        "collection"
      ),

      collectionOnly:
        fields.collection_only === "true",

      collectionQuantity:
        fields.collection_quantity,

      giftProduct: getReferenceByKey(
        metaobject.fields,
        "gift_product"
      ),
    };
  }

  function parseConditionTypes(value) {
    if (!value) return [];

    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed
        : [parsed];
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
    const field = fields.find(
      (item) => item.key === key
    );

    return (
      field?.reference ||
      field?.references?.nodes?.[0] ||
      null
    );
  }

  function isWithinCampaignPeriod(
    startDatetime,
    endDatetime
  ) {
    const now = new Date();

    if (startDatetime) {
      const start = new Date(startDatetime);

      if (now < start) {
        return false;
      }
    }

    if (endDatetime) {
      const end = new Date(endDatetime);

      if (now > end) {
        return false;
      }
    }

    return true;
  }

  function formatMoney(amount) {
    return `¥${Math.floor(amount).toLocaleString(
      "ja-JP"
    )}`;
  }

  if (loading || collectionsLoading) return null;
  if (!gwp) return null;
  if (!isWithinCampaignPeriod(gwp.startDatetime, gwp.endDatetime)) return null;
  if (!activeWarningInfo) return null;

  return (
    <s-banner tone="warning">
      <s-stack direction="block" gap="small-100">
        <s-text>
          {activeWarningInfo.collectionTitle}の対象商品合計金額は{" "}
          {formatMoney(activeWarningInfo.currentAmount)} です。
        </s-text>
      </s-stack>
    </s-banner>
  );
}