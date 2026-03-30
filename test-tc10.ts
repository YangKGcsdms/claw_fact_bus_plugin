declare const f: any;
declare const items: any[];
for (const item of items) {
  f({
    a: item.a,
    b: () => {
      return item.a;
    },
  },
  });
}
