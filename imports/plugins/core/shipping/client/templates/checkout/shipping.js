import _ from "lodash";
import { Meteor } from "meteor/meteor";
import { EJSON } from "meteor/ejson";
import { Template } from "meteor/templating";
import { ReactiveDict } from "meteor/reactive-dict";
import { Reaction } from "/client/api";
import { Cart, Media, Shops } from "/lib/collections";


// Because we are duplicating shipment quotes across shipping records
// we will get duplicate shipping quotes but we only want to diplay one
// So this function eliminates duplicates
/**
 * Return a unique list of objects
 * @param {Array} objs - An array of objects
 * @returns {Array} An array of object only containing unique members
 * @private
 */
function uniqObjects(objs) {
  const jsonBlobs = objs.map((obj) => {
    return JSON.stringify(obj);
  });
  const uniqueBlobs = _.uniq(jsonBlobs);
  return uniqueBlobs.map((blob) => {
    return EJSON.parse(blob);
  });
}

// cartShippingQuotes
// returns multiple methods
/**
 * cartShippingQuotes - returns a list of all the shipping costs/quotations
 * of each available shipping carrier like UPS, Fedex etc.
 * @param {Object} currentCart - The current cart that's about
 * to be checked out.
 * @param {String} shopId - The shop that shipping quotes are for.
 * @returns {Array} - an array of the quotations of multiple shipping
 * carriers.
 */
function cartShippingQuotes(currentCart, shopId) {
  const cart = currentCart || Cart.findOne();
  const shipmentQuotes = [];
  if (cart && cart.shipping) {
    const shipping = cart.shipping.find(shippingRec => shippingRec.shopId === shopId);
    if (shipping && shipping.shipmentQuotes) {
      for (const quote of shipping.shipmentQuotes) {
        quote.shopId = shopId;
        shipmentQuotes.push(quote);
      }
    }
  }
  return uniqObjects(shipmentQuotes);
}

function shippingMethodsQueryStatus(currentCart, shopId) {
  const cart = currentCart || Cart.findOne();
  let queryStatus;
  let failingShippingProvider;

  if (cart && cart.shipping) {
    const shopShipping = cart.shipping.find(shippingRec => shippingRec.shopId === shopId);
    if (shopShipping) {
      const quotesQueryStatus = shopShipping.shipmentQuotesQueryStatus;
      if (quotesQueryStatus) {
        queryStatus = quotesQueryStatus.requestStatus;
      }
      if (queryStatus === "error") {
        failingShippingProvider = quotesQueryStatus.shippingProvider;
      }
    }
  }

  return [queryStatus, failingShippingProvider];
}


/**
 * cartShipmentMethods - gets current shipment methods.
 * @return {Array} - Returns multiple methods if more than one
 * carrier has been chosen.
 */
function cartShipmentMethods(shopId) {
  const cart = Cart.findOne();
  const shipmentMethods = [];
  if (cart && cart.shipping) {
    const shopShipping = cart.shipping.find(shipRec => shipRec.shopId === shopId);
    if (shopShipping) {
      shipmentMethods.push(shopShipping.shipmentMethod);
    }
  }
  return shipmentMethods;
}

function enabledShipping() {
  const enabledShippingArr = [];
  const apps = Reaction.Apps({
    provides: "shippingSettings",
    enabled: true,
    shopId: Reaction.getPrimaryShopId()
  });
  for (const app of apps) {
    if (app.enabled === true) enabledShippingArr.push(app);
  }
  return enabledShippingArr;
}

Template.coreCheckoutShipping.onCreated(function () {
  this.autorun(() => {
    this.subscribe("Shipping");
  });

  this.isLoadingShippingMethods = new ReactiveDict();

  const enabled = enabledShipping();
  const isEnabled = enabled.length;
  const shippingOpts = {
    provides: "settings",
    name: "settings/shipping",
    template: "shippingSettings"
  };

  // If shipping not set, show shipping settings dashboard
  if (!isEnabled) {
    Reaction.showActionView(shippingOpts);
  }
});

Template.coreCheckoutShipping.helpers({
  shopSummaryList: function () {
    const cart = Cart.findOne();
    if (!cart && !cart.items) {
      return;
    }

    Meteor.subscribe("CartImages", cart.items);
    const itemsByShop = cart.getItemsByShop();
    return Object.keys(itemsByShop).map(shopId => {
      // Todo: merchant basic information like this ,probably should exist somewhere in the cart and not fetched
      // dynamically. Maybe a Shops array with basic info's like name slug avatar
      const shop = Shops.findOne(shopId);
      const shopName = shop && shop.name || shopId;
      const products = itemsByShop[shopId];

      products.forEach(item => {
        let img = Media.findOne({
          "metadata.variantId": item.variants._id
        });
        if (img) {
          item.imgUrl = img.url({store: "thumbnail"});
          return;
        }
        img = Media.findOne({
          "metadata.productId": item.productId
        });
        item.imgUrl = img && img.url({store: "thumbnail"});
      });

      return {shopId, shopName, products};
    });
  },

  // retrieves current rates and updates shipping rates
  // in the users cart collection (historical, and prevents repeated rate lookup)
  shipmentQuotes: function (shopId) {
    const instance = Template.instance();
    if (instance.subscriptionsReady()) {
      const cart = Cart.findOne();


      // isLoadingShippingMethods is updated here because, when this template
      // reacts to a change in data, this method is called before hasShippingMethods().
      const isLoadingShippingMethods = shippingMethodsQueryStatus(shopId)[0] === "pending";
      instance.isLoadingShippingMethods.set(shopId, isLoadingShippingMethods);

      const shippingQuotes = cartShippingQuotes(cart, shopId);
      return shippingQuotes;
    }
  },

  hasShippingMethods(shopId) {
    const instance = Template.instance();
    const isLoadingShippingMethods = instance.isLoadingShippingMethods.get(shopId);
    if (isLoadingShippingMethods) {
      return true;
    }

    // Useful for when shipping methods are enabled, but querying them fails
    // due to internet connection issues.
    const quotesQueryStatus = shippingMethodsQueryStatus(shopId);
    const didAllQueriesFail =
      quotesQueryStatus[0] === "error" && quotesQueryStatus[1] === "all";
    if (didAllQueriesFail) {
      return false;
    }

    const hasEnabledShippingProviders = enabledShipping().length > 0;
    if (hasEnabledShippingProviders) {
      return true;
    }

    return false;
  },

  // helper to display currently selected shipmentMethod
  isSelected: function () {
    const shipmentMethods = cartShipmentMethods(this.shopId);

    for (const method of shipmentMethods) {
      // if there is already a selected method, set active
      if (_.isEqual(this.method, method)) {
        return "active";
      }
    }
    return null;
  },

  isReady() {
    const instance = Template.instance();
    const isReady = instance.subscriptionsReady();

    if (Reaction.Subscriptions.Cart.ready()) {
      if (isReady) {
        return true;
      }
    }

    return false;
  },

  /**
   * Template helper that checks to see if the user has permissions for the shop
   * responsible for shipping rates. This is the primary shop unless
   * `merchantShippingRates` is enabled in marketplace
   * @method isAdmin
   * @return {Boolean} true if the user has admin access, otherwise false
   */
  isAdmin() {
    const marketplaceSettings = Reaction.marketplace;
    if (marketplaceSettings && marketplaceSettings.merchantShippingRates) {
      Reaction.hasAdminAccess();
    }
    return Reaction.hasAdminAccess(Reaction.getPrimaryShopId());
  }
});

//
// Set and store cart shipmentMethod
// this copies from shipmentMethods (retrieved rates)
// to shipmentMethod (selected rate)
//
Template.coreCheckoutShipping.events({
  "click .list-group-item": function (event) {
    event.preventDefault();
    event.stopPropagation();
    const self = this;
    const cart = Cart.findOne();

    try {
      Meteor.call("cart/setShipmentMethod", cart._id, self.method, self.shopId);
    } catch (error) {
      throw new Meteor.Error(error,
        "Cannot change methods while processing.");
    }
  },
  "click [data-event-action=configure-shipping]"(event) {
    event.preventDefault();

    const dashboardRegistryEntry = Reaction.Apps({ name: "reaction-dashboard", provides: "shortcut" });
    const shippingRegistryEntry = Reaction.Apps({ name: "reaction-shipping", provides: "settings" });

    Reaction.showActionView([
      dashboardRegistryEntry[0],
      shippingRegistryEntry[0]
    ]);
  }
});
