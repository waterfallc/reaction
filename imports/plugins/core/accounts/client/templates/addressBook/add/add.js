import { $ } from "meteor/jquery";
import { Session } from "meteor/session";
import { Meteor } from "meteor/meteor";
import { HTTP } from "meteor/http";
import { ReactiveVar } from "meteor/reactive-var";
import { AutoForm } from "meteor/aldeed:autoform";
import { Template } from "meteor/templating";
import { Reaction, i18next } from "/client/api";
import * as Collections from "/lib/collections";

Template.addressBookAdd.onCreated(function () {
  this.currentCountry = new ReactiveVar(null);
  // hit Reaction's GeoIP server and try to determine the user's country
  HTTP.get("https://geo.getreaction.io/json/", (err, res) => {
    if (!err) {
      this.currentCountry.set(res.data.country_code);
    }
  });
});

Template.addressBookAdd.helpers({
  thisAddress() {
    const thisAddress = {};

    // admin should receive their account
    const account = Collections.Accounts.findOne({
      userId: Meteor.userId()
    });

    if (account && account.profile) {
      if (account.profile.name) {
        thisAddress.fullName = account.profile.name;
      }
      // if this will be the first address we set defaults here and not display
      // them inside form
      if (account.profile.addressBook) {
        if (account.profile.addressBook.length === 0) {
          thisAddress.isShippingDefault = true;
          thisAddress.isBillingDefault = true;
        }
      }
    }

    const shop = Collections.Shops.findOne(Reaction.getShopId());

    // Set default country code based on shop's shipping address
    if (shop && Array.isArray(shop.addressBook) && shop.addressBook.length > 0) {
      const defaultAddress = shop.addressBook.find((address) => address.isShippingDefault);
      const defaultCountryCode = defaultAddress.country;
      if (defaultCountryCode) {
        thisAddress.country = defaultCountryCode;
      }
    }

    if (Session.get("address")) {
      thisAddress.postal = Session.get("address").zipcode;
      thisAddress.country = Session.get("address").countryCode;
      thisAddress.city = Session.get("address").city;
      thisAddress.region = Session.get("address").state;
    }

    // update the reactive country code from the GeoIP lookup (if found)
    thisAddress.country = Template.instance().currentCountry.get() || thisAddress.country;

    return thisAddress;
  },

  hasAddressBookEntries() {
    const account = Collections.Accounts.findOne({
      userId: Meteor.userId()
    });
    if (account) {
      if (account.profile) {
        if (account.profile.addressBook) {
          return account.profile.addressBook.length > 0;
        }
      }
    }

    return false;
  },

  hasErrors() {
    const addressState = Session.get("addressState");
    if (addressState.formErrors) {
      return addressState.formErrors.length;
    }
    return false;
  },

  formErrors() {
    const addressState = Session.get("addressState");
    if (!addressState.errorsShown) {
      addressState.formErrors.forEach((formError) => {
        Alerts.inline(formError.details, "error", {
          placement: "addressBookAdd",
          autoHide: false
        });
      });
      addressState.errorsShown = true;
      Session.set("addressState", addressState);
    }
  }
});

Template.addressBookAdd.events({
  "click button#bypass-address-validation"(event) {
    event.preventDefault();
    event.stopPropagation();
    const instance = Template.instance();
    Alerts.alert({
      text: "With an invalid address a store may consider your order to be high risk and not complete your order." +
      "If you are sure your address is correct please click proceed",
      type: "warning",
      showCancelButton: true
    }, (isConfirm) => {
      if (isConfirm) {
        Meteor.call("accounts/markTaxCalculationFailed", (err, res) => {
          if (!err && res) {
            Meteor.call("accounts/markAddressValidationBypassed", (error, result) => {
              if (!error && result) {
                Alerts.removeSeen();
                $("button#bypass-address-validation").hide();
                const addressState = Session.get("addressState");
                addressState.validationBypassed = true;
                Session.set("addressState", addressState);
                const insertDoc = addressState.address;
                Meteor.call("accounts/addressBookAdd", insertDoc, (insError, insResult) => {
                  if (insError) {
                    Alerts.toast(i18next.t("addressBookAdd.failedToAddAddress", { err: insError.message }), "error");
                    this.done(new Error("Failed to add address: ", error));
                    return false;
                  }
                  if (insResult) {
                    const addressBook = $(instance.firstNode).closest(".address-book");
                    addressBook.trigger($.Event("showMainView"));
                    return true;
                  }
                });
              }
            });
          }
        });
      }
    });
  }
});

/**
 * addressBookAddForm form handling
 * @description gets accountId and calls addressBookAdd method
 * @fires "accounts/addressBookAdd" method
 */
AutoForm.hooks({
  addressBookAddForm: {
    onSubmit(insertDoc) {
      const { done, event, template } = this; // provided by AutoForm
      event.preventDefault();
      const addressBook = $(template.firstNode).closest(".address-book");

      function handleError(error) {
        Alerts.toast(i18next.t("addressBookAdd.failedToAddAddress", { err: error.message }), "error");
        done(error);
      }

      Meteor.call("accounts/validateAddress", insertDoc, (err, res) => {
        if (err) return handleError(err);
        // address failed validation, pass back to add screen and show errors
        if (!res.validation && res.formErrors && res.formErrors.length) {
          const addressState = {
            requiresReview: false,
            address: insertDoc,
            formErrors: res.formErrors,
            fieldErrors: res.fieldErrors
          };
          Session.set("addressState", addressState);
          addressBook.trigger($.Event("addressAddInError"));
        } else if (res.validated) {
          Meteor.call("accounts/addressBookAdd", insertDoc, (error) => {
            if (error) return handleError(error);
            done();
            addressBook.trigger($.Event("showMainView")); // Show the grid
          });
        } else {
          // set addressState and kick it back to review
          const addressState = {
            requiresReview: true,
            address: insertDoc,
            validatedAddress: res.validatedAddress,
            formErrors: res.formErrors,
            fieldErrors: res.fieldErrors,
            errorsShown: false
          };
          Session.set("addressState", addressState);
          addressBook.trigger($.Event("addressRequiresReview"));
        }
      });
    }
  }
});
