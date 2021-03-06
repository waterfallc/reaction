import _ from "lodash";
import { Template } from "meteor/templating";
import { Meteor } from "meteor/meteor";
import { ReactiveDict } from "meteor/reactive-dict";
import { Reaction } from "/client/api";
import ReactionError from "@reactioncommerce/reaction-error";
import Logger from "/client/modules/logger";
import { Catalog, getPrimaryMediaForItem, ReactionProduct } from "/lib/api";
import { Products } from "/lib/collections";

function updateVariantProductField(variants, field, value) {
  return variants.map((variant) => Meteor.call("products/updateProductField", variant._id, field, value));
}

Template.productSettings.onCreated(function () {
  this.state = new ReactiveDict();
  this.state.setDefault({
    products: [],
    productIds: []
  });

  this.autorun(() => {
    const currentData = Template.currentData();

    if (_.isArray(currentData.products)) {
      const productIds = currentData.products.map((product) => product._id);

      const products = Products.find({
        _id: {
          $in: productIds
        }
      }).fetch();

      this.state.set("productIds", productIds);
      this.state.set("products", products);
    }
  });
});

Template.productSettings.helpers({
  isVisible() {
    const instance = Template.instance();
    const products = instance.state.get("products") || [];

    // Use the first selected product to determin status of bulk, isVisible button
    if (Array.isArray(products) && products.length) {
      return products[0].isVisible;
    }

    return false;
  },
  hasSelectedProducts() {
    return this.products && this.products.length > 0;
  },
  itemWeightActive(weight) {
    const instance = Template.instance();
    const products = instance.state.get("products");
    const tagId = ReactionProduct.getTagIdForPosition();

    for (const product of products) {
      const positions = (product.positions && product.positions[tagId]) || {};
      const currentWeight = positions.weight || 0;
      if (currentWeight === weight) {
        return "active";
      }
    }
    return "";
  }
});

Template.productSettingsListItem.events({
  "click [data-event-action=product-click]"() {
    Reaction.Router.go("product", {
      handle: (this.__published && this.__published.handle) || this.handle
    });

    Reaction.state.set("edit/focus", "productDetails");

    // Set actionView to product admin
    Reaction.setActionView({
      i18nKeyLabel: "productDetailEdit.productSettings",
      label: "Product Settings",
      template: "ProductAdmin"
    });
  }
});

Template.productSettingsListItem.helpers({
  displayPrice() {
    if (this._id) {
      return Catalog.getProductPriceRange(this._id).range;
    }
    return null;
  },

  mediaUrl() {
    const variants = ReactionProduct.getTopVariants(this._id);
    if (!variants || variants.length === 0) return "/resources/placeholder.gif";
    const media = getPrimaryMediaForItem({ productId: this._id, variantId: variants[0]._id });
    if (!media) return "/resources/placeholder.gif";
    return media.url({ store: "thumbnail" });
  },

  listItemActiveClassName(productId) {
    const { handle } = Reaction.Router.current().params;

    if (ReactionProduct.equals("productId", productId) && handle) {
      return "active";
    }

    return "";
  }
});

/**
 * productExtendedControls events
 */

Template.productSettings.events({
  "click [data-event-action=publishProduct]"() {
    const instance = Template.instance();
    const products = instance.state.get("products") || [];

    for (const product of products) {
      // Update the visibility using the first selected product to determine the proper
      // visibility toggle. This is to ensure that all selected products will become visible or not visible
      // at the same time so it's not confusing.
      Meteor.call("products/updateProductField", product._id, "isVisible", !products[0].isVisible);
      // update the variants visibility
      const variants = Products.find({
        ancestors: {
          $in: [product._id]
        }
      });
      updateVariantProductField(variants, "isVisible", !products[0].isVisible);
    }
  },
  "click [data-event-action=cloneProduct]"() {
    ReactionProduct.cloneProduct(this.products);
  },
  "click [data-event-action=archiveProduct]"() {
    ReactionProduct.archiveProduct(this.products);
  },
  "click [data-event-action=changeProductWeight]"(event) {
    event.preventDefault();
    const tagId = ReactionProduct.getTagIdForPosition();
    for (const product of this.products) {
      const weight =
        Template.instance()
          .$(event.currentTarget)
          .data("event-data") || 0;
      const positions = {
        weight,
        updatedAt: new Date()
      };
      /* eslint no-loop-func: 1 */
      //
      //
      Meteor.call("products/updateProductPosition", product._id, positions, tagId, (error) => {
        // eslint-disable-line no-loop-func
        if (error) {
          Logger.warn(error);
          throw new ReactionError("access-denied", error);
        }
      });
    }
  }
});
